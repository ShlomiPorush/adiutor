using AdiutorSync.Core;
using Microsoft.Extensions.Time.Testing;

namespace AdiutorSync.Tests;

/// <summary>A fake clock whose wall time can be set back, as Windows' clock can, while its timestamps keep going.</summary>
internal sealed class ShiftedClock(DateTimeOffset start) : FakeTimeProvider(start)
{
    public TimeSpan Shift { get; set; }

    public override DateTimeOffset GetUtcNow() => base.GetUtcNow() + Shift;

    // The monotonic clock ignores the shift (FakeTimeProvider would derive it from the wall time).
    public override long TimestampFrequency => TimeSpan.TicksPerSecond;

    public override long GetTimestamp() => base.GetUtcNow().Ticks;
}

// When an update may install, against engine commands of the tray and runs from the command line (result review R2,
// R3, R7), and the check-in cadence against a wall clock set back (R6).
public class InstallGateTests
{
    [Fact]
    public async Task The_install_waits_for_a_command_that_started()
    {
        using var h = new Harness();
        var updates = new UpdateCoordinator(h.Loop, new FakeUpdater(), h.Time, NoLog.Instance);
        await h.Tick();
        await updates.CheckAndDownloadAsync(CancellationToken.None);
        // A check-in is under way: the install must not start while it runs.
        h.Engine.CheckinGate = new TaskCompletionSource();
        h.Time.Advance(SyncLoop.CheckinEvery);
        var tick = h.Tick();
        await WaitFor(() => h.Engine.Of("checkin").Count() == 2);
        Assert.False(h.Loop.IsIdle);
        Assert.False(await updates.TryApplyAsync(CancellationToken.None));
        h.Engine.CheckinGate.SetResult();
        await tick;
        Assert.True(await updates.TryApplyAsync(CancellationToken.None));
    }

    [Fact]
    public async Task No_command_starts_once_the_install_holds()
    {
        using var h = new Harness();
        await h.Tick();
        using var hold = await h.Loop.HoldForInstallAsync(CancellationToken.None);
        Assert.NotNull(hold);
        var calls = h.Engine.Calls.Count;
        Assert.Equal("updating", (await h.Loop.RunCommandAsync(["connect"], null, CancellationToken.None)).Failure);
        await h.Advance(TimeSpan.FromMinutes(3));
        h.Loop.SyncNow();
        await h.Tick();
        Assert.Equal(calls, h.Engine.Calls.Count);
    }

    [Fact]
    public async Task A_run_from_the_command_line_holds_back_the_update()
    {
        using var h = new Harness();
        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0.AddHours(-1)), runningSince: "2026-11-17T08:59:00.000Z");
        await h.Tick();
        var updater = new FakeUpdater();
        var updates = new UpdateCoordinator(h.Loop, updater, h.Time, NoLog.Instance);
        Assert.False(h.Loop.IsIdle);
        Assert.Equal(UpdateCoordinator.RetryWhenBusy, await updates.CheckAndDownloadAsync(CancellationToken.None));
        Assert.Equal(0, updater.Checks);
    }

    [Fact]
    public async Task A_run_from_the_command_line_that_started_since_the_last_status_stops_the_install()
    {
        using var h = new Harness();
        await h.Tick();
        var updater = new FakeUpdater();
        var updates = new UpdateCoordinator(h.Loop, updater, h.Time, NoLog.Instance);
        await updates.CheckAndDownloadAsync(CancellationToken.None);
        // The owner starts `run` by hand; the tray's last status does not show it yet.
        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0.AddHours(-1)), runningSince: "2026-11-17T09:00:30.000Z");
        Assert.True(h.Loop.IsIdle);
        Assert.False(await updates.TryApplyAsync(CancellationToken.None));
        Assert.Empty(updater.Applied);
        // Nothing stays held.
        Assert.Null((await h.Loop.RunCommandAsync(["t3-connect"], null, CancellationToken.None)).Failure);
    }

    [Fact]
    public async Task An_install_that_does_not_start_leaves_the_tray_running()
    {
        using var h = new Harness();
        await h.Tick();
        var updater = new FakeUpdater { ApplyThrows = new InvalidOperationException("Update.exe blocked") };
        var updates = new UpdateCoordinator(h.Loop, updater, h.Time, NoLog.Instance);
        await updates.CheckAndDownloadAsync(CancellationToken.None);
        Assert.False(await updates.TryApplyAsync(CancellationToken.None));
        // The hold is released: runs and commands go on.
        h.Loop.SyncNow();
        await h.Tick();
        Assert.Single(h.Runs);
        await h.Loop.CurrentRun;
    }

    [Fact]
    public async Task Check_ins_go_on_when_the_wall_clock_is_set_back()
    {
        var clock = new ShiftedClock(Harness.T0);
        using var h = new Harness(time: clock);
        await h.Tick();
        Assert.Single(h.Reports);
        clock.Shift = TimeSpan.FromHours(-1);
        await h.Advance(SyncLoop.CheckinEvery);
        Assert.Equal(2, h.Reports.Count);
        await h.Advance(SyncLoop.CheckinEvery);
        Assert.Equal(3, h.Reports.Count);
    }

    private static async Task WaitFor(Func<bool> condition)
    {
        for (var i = 0; i < 400 && !condition(); i++)
            await Task.Delay(25);
        Assert.True(condition());
    }
}
