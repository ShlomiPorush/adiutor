using AdiutorSync.Core;

namespace AdiutorSync.Tests;

/// <summary>A stand-in for Velopack's update manager: each step can be held open until the test lets it go.</summary>
internal sealed class FakeUpdater : IAppUpdater
{
    public bool IsInstalled { get; set; } = true;
    public object? Available { get; set; } = "1.2.4";
    public TaskCompletionSource? DownloadGate { get; set; }
    public int Checks { get; private set; }
    public int Downloads { get; private set; }
    public List<object> Applied { get; } = [];

    /** When set, Apply throws it, as Velopack does when Update.exe cannot start. */
    public Exception? ApplyThrows { get; set; }

    public Task<object?> CheckAsync(CancellationToken cancellationToken)
    {
        Checks++;
        return Task.FromResult(Available);
    }

    public async Task DownloadAsync(object update, CancellationToken cancellationToken)
    {
        Downloads++;
        if (DownloadGate is { } gate)
            await gate.Task.WaitAsync(cancellationToken);
    }

    public void Apply(object update)
    {
        if (ApplyThrows is { } e)
            throw e;
        Applied.Add(update);
    }
}

public class UpdateTests
{
    [Fact]
    public async Task A_development_build_never_looks_for_updates()
    {
        using var h = new Harness();
        var updater = new FakeUpdater { IsInstalled = false };
        await new UpdateCoordinator(h.Loop, updater, h.Time, NoLog.Instance).RunAsync(TestContext.Current.CancellationToken);
        Assert.Equal(0, updater.Checks);
    }

    [Fact]
    public async Task Downloads_and_installs_when_nothing_runs()
    {
        using var h = new Harness();
        await h.Tick();
        var updater = new FakeUpdater();
        var updates = new UpdateCoordinator(h.Loop, updater, h.Time, NoLog.Instance);
        Assert.Equal(TimeSpan.Zero, await updates.CheckAndDownloadAsync(CancellationToken.None));
        Assert.True(h.Loop.Snapshot.UpdateReady);
        Assert.Equal(IconState.UpdateReady, IconStates.Map(h.Loop.Snapshot));
        Assert.True(await updates.TryApplyAsync(CancellationToken.None));
        Assert.Equal(["1.2.4"], updater.Applied);
    }

    [Fact]
    public async Task No_update_means_the_next_check_in_six_hours()
    {
        using var h = new Harness();
        var updater = new FakeUpdater { Available = null };
        var updates = new UpdateCoordinator(h.Loop, updater, h.Time, NoLog.Instance);
        Assert.Equal(UpdateCoordinator.CheckEvery, await updates.CheckAndDownloadAsync(CancellationToken.None));
        Assert.False(h.Loop.Snapshot.UpdateReady);
        Assert.False(await updates.TryApplyAsync(CancellationToken.None));
    }

    [Fact]
    public async Task Nothing_is_checked_while_a_run_is_going()
    {
        using var h = new Harness();
        h.Engine.RunGate = new TaskCompletionSource();
        h.Loop.SyncNow();
        await h.Tick();
        var updater = new FakeUpdater();
        var updates = new UpdateCoordinator(h.Loop, updater, h.Time, NoLog.Instance);
        Assert.Equal(UpdateCoordinator.RetryWhenBusy, await updates.CheckAndDownloadAsync(CancellationToken.None));
        Assert.Equal(0, updater.Checks);
        h.Engine.RunGate.SetResult();
        await h.Loop.CurrentRun;
    }

    [Fact]
    public async Task Runs_wait_during_the_download_and_the_install_waits_for_a_run()
    {
        using var h = new Harness();
        var id = Fixture.RequestId();
        var updater = new FakeUpdater { DownloadGate = new TaskCompletionSource() };
        var updates = new UpdateCoordinator(h.Loop, updater, h.Time, NoLog.Instance);
        var download = updates.CheckAndDownloadAsync(CancellationToken.None);
        // A claim comes in meanwhile: it does not start while the download holds the runs.
        h.Engine.Checkin = () => Lines.Checkin(id);
        await h.Tick();
        Assert.Empty(h.Runs);
        updater.DownloadGate.SetResult();
        await download;
        h.Engine.RunGate = new TaskCompletionSource();
        await h.Tick();
        Assert.Equal(["run", "--request", id], Assert.Single(h.Runs).Args);
        // The run is going: the install waits for it.
        Assert.False(await updates.TryApplyAsync(CancellationToken.None));
        Assert.Empty(updater.Applied);
        h.Engine.RunGate.SetResult();
        await h.Loop.CurrentRun;
        Assert.True(await updates.TryApplyAsync(CancellationToken.None));
    }

    [Fact]
    public async Task A_slow_download_stops_at_the_limit_and_runs_go_on()
    {
        using var h = new Harness();
        var updater = new FakeUpdater { DownloadGate = new TaskCompletionSource() };
        var updates = new UpdateCoordinator(h.Loop, updater, h.Time, NoLog.Instance);
        var download = updates.CheckAndDownloadAsync(CancellationToken.None);
        h.Loop.SyncNow();
        await h.Tick();
        Assert.Empty(h.Runs);
        h.Time.Advance(UpdateCoordinator.HoldLimit);
        Assert.Equal(UpdateCoordinator.CheckEvery, await download.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken));
        Assert.False(h.Loop.Snapshot.UpdateReady);
        await h.Tick();
        Assert.Single(h.Runs);
        await h.Loop.CurrentRun;
        // Well under the 10 minutes a claim's lease lasts.
        Assert.True(UpdateCoordinator.HoldLimit < TimeSpan.FromMinutes(10));
    }

    [Fact]
    public async Task The_install_stops_other_engine_commands()
    {
        using var h = new Harness();
        var updater = new FakeUpdater();
        var updates = new UpdateCoordinator(h.Loop, updater, h.Time, NoLog.Instance);
        await updates.CheckAndDownloadAsync(CancellationToken.None);
        using (h.Loop.HoldAll())
        {
            var outcome = await h.Loop.RunCommandAsync(["connect"], null, CancellationToken.None);
            Assert.Equal("updating", outcome.Failure);
        }
        Assert.True(await updates.TryApplyAsync(CancellationToken.None));
    }
}
