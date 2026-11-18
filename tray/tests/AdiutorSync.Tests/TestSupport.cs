using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using AdiutorSync.Core;

namespace AdiutorSync.Tests;

/// <summary>A new folder per test under the system's temporary folder (or ADIUTOR_TEST_TMP), removed afterwards.</summary>
public sealed class TempFolder : IDisposable
{
    public TempFolder()
    {
        var root = Environment.GetEnvironmentVariable("ADIUTOR_TEST_TMP") is { Length: > 0 } t ? t : Path.GetTempPath();
        // A random name from a CSPRNG per run; nothing in it is a secret.
        Root = System.IO.Path.Combine(root, "adiutor-tray-test-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant());
        Directory.CreateDirectory(Root);
    }

    public string Root { get; }

    public string File(string name) => System.IO.Path.Combine(Root, name);

    public void Dispose()
    {
        try
        {
            Directory.Delete(Root, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}

public static class Fixture
{
    public static string[] Lines(string name) =>
        System.IO.File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "Fixtures", name));

    public static EngineResult Result(string name) =>
        Lines(name).Select(EngineOutput.ParseLine).OfType<EngineResult>().Single();

    /** A request id as Adiutor makes them: a random UUID. */
    public static string RequestId() => Guid.NewGuid().ToString();
}

/// <summary>Engine result lines built the way contract.ts writes them.</summary>
public static class Lines
{
    public static string Status(
        string adiutor = "connected",
        string t3 = "connected",
        JsonObject? lastRun = null,
        string? runningSince = null,
        string? claim = null) =>
        new JsonObject
        {
            ["type"] = "result",
            ["v"] = 2,
            ["command"] = "status",
            ["ok"] = true,
            ["adiutor"] = new JsonObject { ["state"] = adiutor, ["url"] = "https://adiutor.example.com", ["revocationPending"] = false },
            ["t3"] = new JsonObject { ["state"] = t3, ["revocationPending"] = false },
            ["lastRun"] = lastRun,
            ["lastGoodSyncAt"] = null,
            ["running"] = runningSince is null ? null : new JsonObject { ["startedAt"] = runningSince },
            ["paused"] = null,
            ["claim"] = claim is null ? null : new JsonObject { ["requestId"] = claim, ["receivedAt"] = "2026-11-17T08:00:00.000Z" },
            ["settings"] = new JsonObject { ["problems"] = new JsonArray() },
        }.ToJsonString();

    public static JsonObject Report(DateTimeOffset startedAt, string t3 = "accepted", string? requestId = null) =>
        new()
        {
            ["startedAt"] = Times.Iso(startedAt),
            ["finishedAt"] = Times.Iso(startedAt.AddMinutes(3)),
            ["dryRun"] = false,
            ["requestId"] = requestId,
            ["t3"] = new JsonObject { ["result"] = t3, ["projectsFrom"] = "t3", ["projectsAt"] = Times.Iso(startedAt), ["projects"] = 3, ["threads"] = 9, ["failedProjects"] = 0 },
            ["lastGoodSyncAt"] = null,
        };

    /** A run report as an engine of contract 1 saved it, with its security part. */
    public static JsonObject OldReport(DateTimeOffset startedAt, string t3 = "accepted", string security = "failed", string? requestId = null)
    {
        var report = Report(startedAt, t3, requestId);
        report["security"] = new JsonObject { ["result"] = security, ["reason"] = "push_failed", ["snapshotRunId"] = "r", ["snapshotAt"] = Times.Iso(startedAt), ["repos"] = 2, ["projectsFrom"] = "t3", ["projectsAt"] = Times.Iso(startedAt) };
        return report;
    }

    public static string Run(JsonObject report) =>
        new JsonObject { ["type"] = "result", ["v"] = 2, ["command"] = "run", ["ok"] = true, ["report"] = report }.ToJsonString();

    public static string Busy() =>
        """{"type":"result","v":2,"command":"run","ok":false,"busy":{"startedAt":"2026-11-17T09:00:00.000Z"},"error":{"code":"busy","message":"m"}}""";

    public static string Checkin(string? claim) =>
        new JsonObject
        {
            ["type"] = "result",
            ["v"] = 2,
            ["command"] = "checkin",
            ["ok"] = true,
            ["claim"] = claim is null ? null : new JsonObject { ["requestId"] = claim, ["receivedAt"] = "2026-11-17T08:00:00.000Z" },
        }.ToJsonString();
}

/// <summary>
/// A stand-in engine: answers each command with the line its handler gives. A run can be held open until the test
/// lets it end, so the loop can be watched while a run is going.
/// </summary>
public sealed class FakeEngine : IEngine
{
    public ConcurrentQueue<EngineCommand> Calls { get; } = new();

    public Func<string> Status { get; set; } = () => Lines.Status();

    public Func<string> Checkin { get; set; } = () => Lines.Checkin(null);

    public Func<EngineCommand, string> Run { get; set; } = _ => Lines.Run(Lines.Report(DateTimeOffset.Parse("2026-11-17T09:00:00Z", CultureInfo.InvariantCulture)));

    /** When set, a run waits for it before it answers. */
    public TaskCompletionSource? RunGate { get; set; }

    /** When set, a check-in waits for it before it answers. */
    public TaskCompletionSource? CheckinGate { get; set; }

    /** When true, `hold-run` answers busy: a run holds the engine's run lock. */
    public bool RunLockBusy { get; set; }

    /** When set, `hold-run` ends on its own once it completes (it crashed), whatever the tray asked. */
    public TaskCompletionSource? RunLockEnds { get; set; }

    /** How many `hold-run` commands hold the run lock now. */
    public int RunLockHolders => Volatile.Read(ref _holders);

    private int _holders;

    public IEnumerable<EngineCommand> Of(string name) => Calls.Where(c => c.Name == name);

    public async Task<EngineOutcome> RunAsync(EngineCommand command, CancellationToken cancellationToken)
    {
        Calls.Enqueue(command);
        {
            string line;
            switch (command.Name)
            {
                case "status":
                    line = Status();
                    break;
                case "checkin":
                    if (CheckinGate is { } checkinGate)
                        await checkinGate.Task.WaitAsync(cancellationToken);
                    line = Checkin();
                    break;
                case "hold-run":
                    if (RunLockBusy)
                    {
                        line = """{"type":"result","v":2,"command":"hold-run","ok":false,"busy":{"startedAt":"2026-11-17T08:59:00.000Z"},"error":{"code":"busy","message":"m"}}""";
                        break;
                    }
                    Interlocked.Increment(ref _holders);
                    command.OnEvent?.Invoke(new HeldEvent());
                    try
                    {
                        if (command.InputOpenUntil is { } until)
                        {
                            if (RunLockEnds is { } ends)
                                await Task.WhenAny(until, ends.Task);
                            else
                                await until.WaitAsync(cancellationToken);
                        }
                    }
                    finally
                    {
                        Interlocked.Decrement(ref _holders);
                    }
                    line = """{"type":"result","v":2,"command":"hold-run","ok":true}""";
                    break;
                case "run":
                    if (RunGate is { } gate)
                        await gate.Task.WaitAsync(cancellationToken);
                    line = Run(command);
                    break;
                default:
                    line = $$"""{"type":"result","v":2,"command":"{{command.Name}}","ok":true,"wasConnected":true,"revocationPending":false}""";
                    break;
            }
            return new EngineOutcome(EngineOutput.ParseLine(line) as EngineResult, null);
        }
    }
}
