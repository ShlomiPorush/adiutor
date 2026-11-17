using System.Diagnostics;
using System.Text;

namespace AdiutorSync.Core;

/// <summary>One engine command: its arguments (without --json, which is always added), the input and the limit.</summary>
public sealed record EngineCommand(IReadOnlyList<string> Args, TimeSpan Timeout, string? Stdin = null, Action<EngineEvent>? OnEvent = null)
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

    /** Engine processes of this tray that are running now. */
    int Active { get; }
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
    private int _active;

    public int Active => Volatile.Read(ref _active);

    public async Task<EngineOutcome> RunAsync(EngineCommand command, CancellationToken cancellationToken)
    {
        var info = new ProcessStartInfo(location.NodePath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = Path.GetDirectoryName(location.ScriptPath)!,
        };
        info.ArgumentList.Add(location.ScriptPath);
        foreach (var arg in command.Args)
            info.ArgumentList.Add(arg);
        info.ArgumentList.Add("--json");

        Interlocked.Increment(ref _active);
        try
        {
            using var process = new Process { StartInfo = info };
            try
            {
                if (!process.Start())
                    return Fail(command, "start_failed");
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
            {
                return Fail(command, "start_failed");
            }
            if (!job.Assign(process))
            {
                // Never run the engine outside the job.
                Kill(process);
                return Fail(command, "job_failed");
            }

            using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            limit.CancelAfter(command.Timeout);
            var stderr = process.StandardError.ReadToEndAsync(CancellationToken.None);
            EngineResult? result = null;
            try
            {
                await process.StandardInput.WriteAsync(command.Stdin ?? "").ConfigureAwait(false);
                process.StandardInput.Close();
            }
            catch (IOException)
            {
                // The engine closed its input early; its result, if any, still decides.
            }
            try
            {
                while (await process.StandardOutput.ReadLineAsync(limit.Token).ConfigureAwait(false) is { } line)
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
                await process.WaitForExitAsync(limit.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                Kill(process);
                return Fail(command, cancellationToken.IsCancellationRequested ? "cancelled" : "timeout");
            }
            await stderr.ConfigureAwait(false);
            if (result is null)
                return Fail(command, "no_result");
            log.Info($"engine {command.Name}: ok={result.Ok}{(result.Error is { } f ? $" code={SafeCode(f.Code)}" : "")}");
            return new EngineOutcome(result, null);
        }
        finally
        {
            Interlocked.Decrement(ref _active);
        }
    }

    private EngineOutcome Fail(EngineCommand command, string code)
    {
        log.Info($"engine {command.Name}: {code}");
        return EngineOutcome.Failed(code);
    }

    /** An error code as the log may hold it: the engine's codes are short words; anything else is not written. */
    internal static string SafeCode(string code) =>
        code.Length is > 0 and <= 40 && code.All(c => c is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '_') ? code : "other";

    private static void Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
        }
        catch (System.ComponentModel.Win32Exception)
        {
        }
    }
}
