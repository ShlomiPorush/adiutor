using AdiutorSync.Core;

namespace AdiutorSync.Tests;

public class IconStateTests
{
    private static readonly DateTimeOffset T = DateTimeOffset.Parse("2026-11-17T09:00:00Z", CultureInfo.InvariantCulture);

    private static EngineStatus Status(ConnectionState adiutor = ConnectionState.Connected, ConnectionState t3 = ConnectionState.Connected, RunReport? last = null) =>
        new(new AdiutorConnection(adiutor, "https://adiutor.example.com", false), new T3Connection(t3, null, null, false), last, null, null, null, []);

    private static RunReport Report(PartResult t3, PartResult security) =>
        new(T, T, false, null, new RunPart(t3, null), new RunPart(security, null), null);

    private static TraySnapshot Snap(EngineStatus? status, bool paused = false, RunningRun? running = null, bool update = false, DateTimeOffset? elsewhere = null) =>
        new() { Status = status, Settings = new TraySettings(), Paused = paused, Running = running, UpdateReady = update, RunningElsewhereSince = elsewhere };

    public static TheoryData<string, IconState> Cases => new()
    {
        { "synced", IconState.Synced },
        { "never-run", IconState.Synced },
        { "partial", IconState.Problem },
        { "unknown", IconState.Problem },
        { "paused", IconState.Paused },
        { "paused-problem", IconState.Paused },
        { "adiutor-ended", IconState.NotConnected },
        { "t3-not-connected", IconState.NotConnected },
        { "no-status", IconState.NotConnected },
        { "running", IconState.Syncing },
        { "running-elsewhere", IconState.Syncing },
        { "running-update", IconState.Syncing },
        { "update", IconState.UpdateReady },
        { "update-not-connected", IconState.UpdateReady },
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void Maps_each_state(string name, IconState expected)
    {
        var good = Report(PartResult.Accepted, PartResult.Accepted);
        var run = new RunningRun(RunKind.Scheduled, null, T);
        var snapshot = name switch
        {
            "synced" => Snap(Status(last: good)),
            "never-run" => Snap(Status()),
            "partial" => Snap(Status(last: Report(PartResult.Accepted, PartResult.Partial))),
            "unknown" => Snap(Status(last: Report(PartResult.OutcomeUnknown, PartResult.Accepted))),
            "paused" => Snap(Status(last: good), paused: true),
            "paused-problem" => Snap(Status(last: Report(PartResult.Failed, PartResult.Failed)), paused: true),
            "adiutor-ended" => Snap(Status(adiutor: ConnectionState.Ended, last: good)),
            "t3-not-connected" => Snap(Status(t3: ConnectionState.NotConnected, last: good)),
            "no-status" => Snap(null),
            "running" => Snap(Status(last: good), running: run),
            "running-elsewhere" => Snap(Status(last: good), elsewhere: T),
            "running-update" => Snap(Status(last: good), running: run, update: true),
            "update" => Snap(Status(last: good), update: true),
            "update-not-connected" => Snap(Status(adiutor: ConnectionState.NotConnected), update: true),
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };
        Assert.Equal(expected, IconStates.Map(snapshot));
    }

    [Theory]
    [InlineData("1.4.0", "1.4.0")]
    [InlineData("1.4.0+abc123", "1.4.0")]
    [InlineData("0.0.0-dev", "0.0.0-dev")]
    [InlineData("1.4.0 beta", "0.0.0")]
    [InlineData("", "0.0.0")]
    [InlineData(null, "0.0.0")]
    public void Version_keeps_to_the_checkin_rule(string? informational, string expected)
    {
        var version = TrayVersion.FromInformational(informational);
        Assert.Equal(expected, version);
        Assert.True(TrayVersion.IsAllowed(version));
    }
}
