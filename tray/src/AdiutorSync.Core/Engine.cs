using System.Text;

namespace AdiutorSync.Core;

/// <summary>One engine command: its arguments (without --json, which is always added), the input (kept open until
/// InputOpenUntil completes, for hold-run) and the limit.</summary>
public sealed record EngineCommand(
    IReadOnlyList<string> Args,
    TimeSpan Timeout,
    string? Stdin = null,
    Action<EngineEvent>? OnEvent = null,
    Task? InputOpenUntil = null)
{
    public string Name => Args.Count > 0 ? Args[0] : "";
}

/// <summary>
/// What a command came to: its result line, or, without one, why there is none (`start_failed`, `job_failed`,
/// `timeout`, `cancelled`, `no_result`).
/// </summary>
public sealed record EngineOutcome(EngineResult? Result, string? Failure)
{
    public static EngineOutcome Failed(string code) => new(null, code);
}

public interface IEngine
{
    Task<EngineOutcome> RunAsync(EngineCommand command, CancellationToken cancellationToken);
}

/// <summary>Where the engine is: node.exe and adiutor-sync.js.</summary>
public sealed record EngineLocation(string NodePath, string ScriptPath);

public static class EngineLocator
{
    public const string ScriptName = "adiutor-sync.js";

    /**
     * The installed tray carries both in its own folder (owner's decision D-T1: a pinned node.exe ships with it). A
     * development build uses the settings file's enginePath and the first node.exe on PATH, always by its full path
     * (Windows would otherwise look in the current folder first). Null when either cannot be found.
     */
    public static EngineLocation? Find(string appFolder, string? enginePath, Func<string, string?> env)
    {
        var bundledNode = Path.Combine(appFolder, "node.exe");
        var bundledScript = Path.Combine(appFolder, ScriptName);
        if (File.Exists(bundledNode) && File.Exists(bundledScript))
            return new EngineLocation(bundledNode, bundledScript);
        if (string.IsNullOrWhiteSpace(enginePath) || !Path.IsPathFullyQualified(enginePath) || !File.Exists(enginePath))
            return null;
        var node = FindOnPath("node.exe", env("PATH"));
        return node is null ? null : new EngineLocation(node, enginePath);
    }

    public static string? FindOnPath(string file, string? path)
    {
        foreach (var dir in (path ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!Path.IsPathFullyQualified(dir))
                continue;
            var candidate = Path.Combine(dir, file);
            if (File.Exists(candidate))
                return candidate;
        }
        return null;
    }
}

/// <summary>
/// Runs the engine: node.exe with adiutor-sync.js and the command's arguments plus --json, inside the tray's Job Object.
/// Reads its JSON lines; stderr is read to its end and dropped. Nothing the engine prints is logged.
/// </summary>
public sealed class NodeEngine(EngineLocation location, EngineJob job, ITrayLog log) : IEngine
{
    /** How long output may go on after the engine ended: a process that inherited its pipe would hold it open. */
    internal static readonly TimeSpan ExitGrace = TimeSpan.FromSeconds(2);

    /** A test seam: runs while the engine process exists, suspended, already in its jobs. */
    internal Action<int>? BeforeResume { get; set; }

    public async Task<EngineOutcome> RunAsync(EngineCommand command, CancellationToken cancellationToken)
    {
        List<string> args = [location.ScriptPath, .. command.Args, "--json"];
        JobProcess? process;
        try
        {
            process = JobProcess.Start(location.NodePath, args, Path.GetDirectoryName(location.ScriptPath)!, job, BeforeResume);
        }
#pragma warning disable CA1031 // Whatever failed, the process was ended with its job; the command did not start.
        catch (Exception)
#pragma warning restore CA1031
        {
            process = null;
        }
        if (process is null)
            return Fail(command, "start_failed");
        using var owned = process;

        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        limit.CancelAfter(command.Timeout);
        using var stop = limit.Token.Register(process.Kill);
        // The output ends when the engine has ended (after a short grace), not only at the pipe's end.
        using var reading = CancellationTokenSource.CreateLinkedTokenSource(limit.Token);
        _ = process.Exited.ContinueWith(_ => CancelAfter(reading, ExitGrace), TaskScheduler.Default);
        var input = WriteInputAsync(process, command);
        var stderr = DrainAsync(process.StandardError, reading.Token);
        EngineResult? result = null;
        try
        {
            while (await process.StandardOutput.ReadLineAsync(reading.Token).ConfigureAwait(false) is { } line)
            {
                switch (EngineOutput.ParseLine(line))
                {
                    case EngineEvent e:
                        command.OnEvent?.Invoke(e);
                        break;
                    case EngineResult r when result is null:
                        result = r;
                        break;
                }
            }
        }
        catch (OperationCanceledException) when (!limit.IsCancellationRequested)
        {
            // The engine ended and its output was held open by another process: what was read decides.
        }
        catch (OperationCanceledException)
        {
        }
        if (limit.IsCancellationRequested)
        {
            await process.Exited.ConfigureAwait(false);
            return Fail(command, cancellationToken.IsCancellationRequested ? "cancelled" : "timeout");
        }
        await process.Exited.ConfigureAwait(false);
        await input.ConfigureAwait(false);
        await stderr.ConfigureAwait(false);
        if (result is null)
            return Fail(command, "no_result");
        log.Info($"engine {command.Name}: ok={result.Ok}{(result.Error is { } f ? $" code={SafeCode(f.Code)}" : "")}");
        return new EngineOutcome(result, null);
    }

    /** Writes the command's input; keeps it open until the command says (hold-run) or the engine ended. */
    private static async Task WriteInputAsync(JobProcess process, EngineCommand command)
    {
        try
        {
            await process.StandardInput.WriteAsync(command.Stdin ?? "").ConfigureAwait(false);
            if (command.InputOpenUntil is { } until)
                await Task.WhenAny(until, process.Exited).ConfigureAwait(false);
            process.StandardInput.Close();
        }
        catch (IOException)
        {
            // The engine closed its input early; its result, if any, still decides.
        }
    }

    private static async Task DrainAsync(StreamReader reader, CancellationToken token)
    {
        try
        {
            await reader.ReadToEndAsync(token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (IOException)
        {
        }
    }

    private static void CancelAfter(CancellationTokenSource source, TimeSpan delay)
    {
        try
        {
            source.CancelAfter(delay);
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private EngineOutcome Fail(EngineCommand command, string code)
    {
        log.Info($"engine {command.Name}: {code}");
        return EngineOutcome.Failed(code);
    }

    /** An error code as the log may hold it: the engine's codes are short words; anything else is not written. */
    public static string SafeCode(string code) =>
        code.Length is > 0 and <= 40 && code.All(c => c is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '_') ? code : "other";

}
