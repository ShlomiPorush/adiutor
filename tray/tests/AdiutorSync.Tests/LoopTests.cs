using System.Text.Json.Nodes;
using AdiutorSync.Core;
using Microsoft.Extensions.Time.Testing;

namespace AdiutorSync.Tests;

/// <summary>A loop over a fake engine, fake time and a new data folder.</summary>
internal sealed class Harness : IDisposable
{
    public static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-11-17T09:00:00Z", CultureInfo.InvariantCulture);

    public Harness(TraySettings? settings = null, TrayState? state = null, FakeTimeProvider? time = null, string? stateFile = null)
    {
        Time = time ?? new FakeTimeProvider(T0);
        if (settings is not null)
            SettingsStore.Save(Dir.File(TraySettings.FileName), settings);
        if (state is not null)
            StateStore.Save(Dir.File(TrayState.FileName), state);
        // The state file as it is on disk, such as one an older tray wrote.
        if (stateFile is not null)
            File.WriteAllText(Dir.File(TrayState.FileName), stateFile);
        // By default the last run started an hour ago, so the schedule is not due yet.
        Engine.Status = () => Lines.Status(lastRun: Lines.Report(T0.AddHours(-1)));
        Loop = new SyncLoop(Engine, Dir.Root, Time, "1.2.3-dev", NoLog.Instance);
        Loop.Notify += Notices.Add;
    }

    public TempFolder Dir { get; } = new();
    public FakeEngine Engine { get; } = new();
    public FakeTimeProvider Time { get; }
    public SyncLoop Loop { get; }
    public List<Notice> Notices { get; } = [];

    public async Task<bool> Tick() => (await Loop.TickAsync(CancellationToken.None)).Done;

    public async Task Advance(TimeSpan by)
    {
        Time.Advance(by);
        await Tick();
    }

    public List<JsonObject> Reports => [.. Engine.Of("checkin").Select(c => JsonNode.Parse(c.Stdin!)!.AsObject())];

    public List<EngineCommand> Runs => [.. Engine.Of("run")];

    public void Dispose() => Dir.Dispose();
}

public class LoopTests
{
    [Fact]
    public async Task Checks_in_every_minute()
    {
        using var h = new Harness();
        await h.Tick();
        Assert.Single(h.Reports);
        await h.Advance(TimeSpan.FromSeconds(30));
        Assert.Single(h.Reports);
        await h.Advance(TimeSpan.FromSeconds(30));
        Assert.Equal(2, h.Reports.Count);
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(3, h.Reports.Count);
        Assert.Empty(h.Runs);
        // The status is read before each check-in.
        Assert.True(h.Engine.Of("status").Count() >= 3);
    }

    [Fact]
    public async Task Report_has_every_field()
    {
        using var h = new Harness();
        await h.Tick();
        var report = h.Reports[0];
        Assert.Equal("1.2.3-dev", report["version"]!.GetValue<string>());
        Assert.False(report["paused"]!.GetValue<bool>());
        Assert.True(report.ContainsKey("pausedUntil") && report["pausedUntil"] is null);
        // The last run started an hour ago and the schedule is every 3 hours.
        Assert.Equal("2026-11-17T11:00:00.000Z", report["nextRunAt"]!.GetValue<string>());
        Assert.True(report.ContainsKey("running") && report["running"] is null);
        Assert.Empty(report["finished"]!.AsArray());
    }

    [Fact]
    public async Task No_checkin_without_the_Adiutor_connection()
    {
        using var h = new Harness();
        h.Engine.Status = () => Lines.Status(adiutor: "not_connected");
        await h.Tick();
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Empty(h.Reports);
        Assert.Empty(h.Runs);
    }

    [Fact]
    public async Task Checks_in_while_a_run_is_going()
    {
        using var h = new Harness();
        h.Engine.RunGate = new TaskCompletionSource();
        h.Loop.SyncNow();
        await h.Tick();
        Assert.Single(h.Runs);
        await h.Advance(TimeSpan.FromMinutes(1));
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(3, h.Reports.Count);
        var running = h.Reports[^1]["running"]!.AsObject();
        Assert.Equal("local", running["kind"]!.GetValue<string>());
        Assert.Equal("2026-11-17T09:00:00.000Z", running["startedAt"]!.GetValue<string>());
        h.Engine.RunGate.SetResult();
        await h.Loop.CurrentRun;
    }

    [Fact]
    public async Task A_claim_runs_its_request_and_its_result_is_reported()
    {
        using var h = new Harness();
        var id = Fixture.RequestId();
        h.Engine.Checkin = () => Lines.Checkin(id);
        h.Engine.RunGate = new TaskCompletionSource();
        h.Engine.Run = c => Lines.Run(Lines.Report(Harness.T0, t3: "partial", requestId: id));
        await h.Tick();
        var run = Assert.Single(h.Runs);
        Assert.Equal(["run", "--request", id], run.Args);
        // Written to the state file before the run starts.
        Assert.Equal(id, StateStore.Load(h.Dir.File(TrayState.FileName)).RunningRequestId);

        await h.Advance(TimeSpan.FromMinutes(1));
        var running = h.Reports[^1]["running"]!.AsObject();
        Assert.Equal("request", running["kind"]!.GetValue<string>());
        Assert.Equal(id, running["requestId"]!.GetValue<string>());
        // The claim handed again while it runs starts nothing more.
        Assert.Single(h.Runs);

        h.Engine.RunGate.SetResult();
        await h.Loop.CurrentRun;
        h.Engine.Checkin = () => Lines.Checkin(null);
        // Reported right after the run, not a minute later.
        await h.Tick();
        var finished = Assert.Single(h.Reports[^1]["finished"]!.AsArray())!.AsObject();
        Assert.Equal(id, finished["requestId"]!.GetValue<string>());
        Assert.Equal("partial", finished["result"]!["t3"]!.GetValue<string>());
        // The server reads GitHub itself: the sync never runs security.
        Assert.Equal("not_run", finished["result"]!["security"]!.GetValue<string>());
        var state = StateStore.Load(h.Dir.File(TrayState.FileName));
        Assert.Null(state.RunningRequestId);
        Assert.Empty(state.Finished);

        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Empty(h.Reports[^1]["finished"]!.AsArray());
        Assert.Single(h.Runs);
    }

    [Fact]
    public async Task A_finished_request_stays_until_a_checkin_is_answered()
    {
        using var h = new Harness();
        var id = Fixture.RequestId();
        h.Engine.Checkin = () => Lines.Checkin(id);
        await h.Tick();
        await h.Loop.CurrentRun;
        // The answer is lost: the engine reports outcome_unknown without a result the tray can use.
        h.Engine.Checkin = () => """{"type":"result","v":2,"command":"checkin","ok":false,"claim":{"requestId":"%ID%","receivedAt":"2026-11-17T08:00:00.000Z"},"error":{"code":"outcome_unknown","message":"m"}}""".Replace("%ID%", id, StringComparison.Ordinal);
        await h.Tick();
        Assert.Single(h.Reports[^1]["finished"]!.AsArray());
        Assert.Equal("outcome_unknown", h.Loop.Snapshot.CheckinProblem);
        h.Engine.Checkin = () => Lines.Checkin(null);
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Single(h.Reports[^1]["finished"]!.AsArray());
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Empty(h.Reports[^1]["finished"]!.AsArray());
        Assert.Single(h.Runs);
    }

    [Fact]
    public async Task A_recovered_claim_never_runs_while_paused()
    {
        using var h = new Harness(new TraySettings { Pause = new Pause(null) });
        var id = Fixture.RequestId();
        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0.AddHours(-1)), claim: id);
        h.Engine.Checkin = () => Lines.Checkin(id);
        await h.Tick();
        await h.Advance(TimeSpan.FromMinutes(1));
        await h.Advance(TimeSpan.FromHours(5));
        Assert.Empty(h.Runs);
        var report = h.Reports[^1];
        Assert.True(report["paused"]!.GetValue<bool>());
        Assert.Null(report["pausedUntil"]);
        Assert.Null(report["nextRunAt"]);

        h.Loop.Resume();
        await h.Tick();
        Assert.Equal(["run", "--request", id], Assert.Single(h.Runs).Args);
        await h.Loop.CurrentRun;
    }

    [Fact]
    public async Task A_claim_waits_for_a_timed_pause_to_end()
    {
        using var h = new Harness();
        var id = Fixture.RequestId();
        h.Loop.PauseFor(TimeSpan.FromHours(1));
        h.Engine.Checkin = () => Lines.Checkin(id);
        await h.Tick();
        Assert.Equal("2026-11-17T10:00:00.000Z", h.Reports[^1]["pausedUntil"]!.GetValue<string>());
        await h.Advance(TimeSpan.FromMinutes(59));
        Assert.Empty(h.Runs);
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Single(h.Runs);
        await h.Loop.CurrentRun;
    }

    [Fact]
    public async Task Pause_is_written_in_the_engine_format_and_resume_removes_it()
    {
        using var h = new Harness();
        h.Loop.PauseFor(TimeSpan.FromHours(4));
        var root = JsonNode.Parse(File.ReadAllText(h.Dir.File(TraySettings.FileName)))!.AsObject();
        Assert.Equal("2026-11-17T13:00:00.000Z", root["pause"]!["until"]!.GetValue<string>());
        h.Loop.PauseFor(null);
        root = JsonNode.Parse(File.ReadAllText(h.Dir.File(TraySettings.FileName)))!.AsObject();
        Assert.Null(root["pause"]!["until"]);
        h.Loop.Resume();
        root = JsonNode.Parse(File.ReadAllText(h.Dir.File(TraySettings.FileName)))!.AsObject();
        Assert.False(root.ContainsKey("pause"));
    }

    [Fact]
    public async Task Pause_pressed_during_a_run_lets_it_finish()
    {
        using var h = new Harness();
        h.Engine.RunGate = new TaskCompletionSource();
        h.Loop.SyncNow();
        await h.Tick();
        h.Loop.PauseFor(null);
        h.Engine.RunGate.SetResult();
        await h.Loop.CurrentRun;
        await h.Advance(TimeSpan.FromHours(10));
        Assert.Single(h.Runs);
        Assert.True(h.Loop.Snapshot.Paused);
    }

    [Fact]
    public async Task One_run_at_a_time()
    {
        using var h = new Harness();
        h.Engine.RunGate = new TaskCompletionSource();
        h.Loop.SyncNow();
        await h.Tick();
        h.Loop.SyncNow();
        await h.Tick();
        h.Engine.Checkin = () => Lines.Checkin(Fixture.RequestId());
        await h.Advance(TimeSpan.FromHours(4));
        Assert.Single(h.Runs);
        Assert.Equal(IconState.Syncing, IconStates.Map(h.Loop.Snapshot));
        h.Engine.RunGate.SetResult();
        await h.Loop.CurrentRun;
    }

    [Fact]
    public async Task Busy_engine_is_shown_and_tried_again_after_a_minute()
    {
        using var h = new Harness();
        var id = Fixture.RequestId();
        h.Engine.Checkin = () => Lines.Checkin(id);
        h.Engine.Run = _ => Lines.Busy();
        await h.Tick();
        await h.Loop.CurrentRun;
        Assert.True(h.Loop.Snapshot.LastStartBusy);
        // A busy run is not finished: nothing is reported for it.
        await h.Advance(TimeSpan.FromSeconds(30));
        Assert.Single(h.Runs);
        await h.Advance(TimeSpan.FromSeconds(30));
        await h.Loop.CurrentRun;
        Assert.Equal(2, h.Runs.Count);
        Assert.All(h.Reports, r => Assert.Empty(r["finished"]!.AsArray()));
    }

    [Fact]
    public async Task A_run_from_the_command_line_counts_as_a_local_run()
    {
        using var h = new Harness();
        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0.AddHours(-5)), runningSince: "2026-11-17T08:59:00.000Z");
        h.Engine.Checkin = () => Lines.Checkin(Fixture.RequestId());
        await h.Tick();
        Assert.Empty(h.Runs);
        var running = h.Reports[^1]["running"]!.AsObject();
        Assert.Equal("local", running["kind"]!.GetValue<string>());
        Assert.Equal(IconState.Syncing, IconStates.Map(h.Loop.Snapshot));
    }

    [Fact]
    public async Task Schedule_runs_every_three_hours_by_default()
    {
        using var h = new Harness();
        var lastStart = Harness.T0.AddHours(-1);
        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(lastStart));
        h.Engine.Run = _ =>
        {
            lastStart = h.Time.GetUtcNow();
            return Lines.Run(Lines.Report(lastStart));
        };
        await h.Tick();
        await h.Advance(TimeSpan.FromMinutes(119));
        Assert.Empty(h.Runs);
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(["run"], Assert.Single(h.Runs).Args);
        await h.Loop.CurrentRun;
        await h.Advance(TimeSpan.FromMinutes(179));
        Assert.Single(h.Runs);
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(2, h.Runs.Count);
        await h.Loop.CurrentRun;
    }

    [Fact]
    public async Task Schedule_follows_the_setting()
    {
        using var h = new Harness(new TraySettings { ScheduleHours = 12 });
        await h.Tick();
        Assert.Equal("2026-11-17T20:00:00.000Z", h.Reports[^1]["nextRunAt"]!.GetValue<string>());
    }

    [Fact]
    public async Task First_start_without_any_run_syncs_at_once()
    {
        using var h = new Harness();
        h.Engine.Status = () => Lines.Status();
        await h.Tick();
        Assert.Single(h.Runs);
        await h.Loop.CurrentRun;
    }

    [Fact]
    public async Task No_scheduled_run_without_the_Adiutor_connection()
    {
        using var h = new Harness();
        h.Engine.Status = () => Lines.Status(adiutor: "ended");
        await h.Tick();
        await h.Advance(TimeSpan.FromHours(6));
        Assert.Empty(h.Runs);
        Assert.Equal(IconState.NotConnected, IconStates.Map(h.Loop.Snapshot));
        Assert.Null(h.Loop.Snapshot.NextRunAt);
    }

    [Fact]
    public async Task Quit_waits_for_the_run_to_finish()
    {
        using var h = new Harness();
        var id = Fixture.RequestId();
        h.Engine.Checkin = () => Lines.Checkin(id);
        h.Engine.RunGate = new TaskCompletionSource();
        await h.Tick();
        h.Loop.RequestQuit();
        Assert.False(await h.Tick());
        Assert.True(h.Loop.Snapshot.Quitting);
        Assert.Equal(IconState.Syncing, IconStates.Map(h.Loop.Snapshot));
        h.Engine.Checkin = () => Lines.Checkin(null);
        h.Engine.RunGate.SetResult();
        await h.Loop.CurrentRun;
        var before = h.Reports.Count;
        Assert.True(await h.Tick());
        // The request's result is reported before the tray ends.
        Assert.Equal(before + 1, h.Reports.Count);
        Assert.Single(h.Reports[^1]["finished"]!.AsArray());
        Assert.Single(h.Runs);
    }

    [Fact]
    public async Task Quit_without_a_run_ends_at_once()
    {
        using var h = new Harness();
        await h.Tick();
        h.Loop.RequestQuit();
        Assert.True(await h.Tick());
    }

    [Fact]
    public async Task Two_scheduled_runs_in_a_row_not_good_notify_once()
    {
        using var h = new Harness();
        h.Engine.Status = () => Lines.Status();
        h.Engine.Run = _ => Lines.Run(Lines.Report(h.Time.GetUtcNow(), t3: "partial"));
        for (var i = 0; i < 3; i++)
        {
            await h.Advance(TimeSpan.FromHours(3));
            await h.Loop.CurrentRun;
        }
        Assert.Equal(3, h.Runs.Count);
        Assert.Equal([Notice.ScheduledRunsNotGood], h.Notices);
    }

    [Fact]
    public async Task A_manual_run_that_fails_does_not_notify()
    {
        using var h = new Harness();
        h.Engine.Run = _ => Lines.Run(Lines.Report(h.Time.GetUtcNow(), t3: "failed"));
        for (var i = 0; i < 2; i++)
        {
            h.Loop.SyncNow();
            await h.Tick();
            await h.Loop.CurrentRun;
        }
        Assert.Empty(h.Notices);
    }

    [Fact]
    public async Task A_connection_that_ends_notifies_but_a_disconnect_does_not()
    {
        using var h = new Harness();
        await h.Tick();
        h.Engine.Status = () => Lines.Status(adiutor: "ended", lastRun: Lines.Report(Harness.T0.AddHours(-1)));
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal([Notice.AdiutorConnectionEnded], h.Notices);

        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0.AddHours(-1)));
        await h.Advance(TimeSpan.FromMinutes(1));
        h.Engine.Status = () => Lines.Status(t3: "not_connected", lastRun: Lines.Report(Harness.T0.AddHours(-1)));
        await h.Loop.RunCommandAsync(["t3-disconnect"], null, CancellationToken.None);
        Assert.Equal([Notice.AdiutorConnectionEnded], h.Notices);
        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0.AddHours(-1)));
        await h.Advance(TimeSpan.FromMinutes(1));
        h.Engine.Status = () => Lines.Status(t3: "ended", lastRun: Lines.Report(Harness.T0.AddHours(-1)));
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal([Notice.AdiutorConnectionEnded, Notice.T3ConnectionEnded], h.Notices);
    }

    [Fact]
    public async Task A_request_run_that_ended_while_the_tray_was_gone_is_reported()
    {
        var id = Fixture.RequestId();
        using var h = new Harness(state: new TrayState { RunningRequestId = id });
        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0.AddHours(-1), t3: "partial", requestId: id), claim: id);
        await h.Tick();
        var finished = Assert.Single(h.Reports[0]["finished"]!.AsArray())!.AsObject();
        Assert.Equal(id, finished["requestId"]!.GetValue<string>());
        Assert.Equal("partial", finished["result"]!["t3"]!.GetValue<string>());
        Assert.Empty(h.Runs);
    }

    [Fact]
    public async Task A_request_run_that_did_not_end_runs_again_when_handed_again()
    {
        var id = Fixture.RequestId();
        using var h = new Harness(state: new TrayState { RunningRequestId = id });
        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0.AddHours(-1)), claim: id);
        h.Engine.Checkin = () => Lines.Checkin(id);
        await h.Tick();
        Assert.Empty(h.Reports[0]["finished"]!.AsArray());
        Assert.Equal(["run", "--request", id], Assert.Single(h.Runs).Args);
        await h.Loop.CurrentRun;
    }

    [Fact]
    public async Task A_request_run_without_a_result_is_not_reported_and_not_run_again()
    {
        using var h = new Harness();
        var id = Fixture.RequestId();
        h.Engine.Checkin = () => Lines.Checkin(id);
        h.Engine.Run = _ => "not a result";
        await h.Tick();
        await h.Loop.CurrentRun;
        // The engine still keeps the claim, and its last run is not this request's.
        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0.AddHours(-1)), claim: id);
        h.Engine.Checkin = () => Lines.Checkin(null);
        await h.Tick();
        await h.Advance(TimeSpan.FromMinutes(1));
        // Nothing made up: Adiutor times the request out to unknown, as for a computer that stopped.
        Assert.All(h.Reports, r => Assert.Empty(r["finished"]!.AsArray()));
        Assert.Single(h.Runs);
    }

    [Fact]
    public async Task A_request_run_without_a_result_is_recovered_from_the_status()
    {
        using var h = new Harness();
        var id = Fixture.RequestId();
        h.Engine.Checkin = () => Lines.Checkin(id);
        // The engine wrote its report, then ended before its result line (a crash, or the limit).
        h.Engine.Run = _ =>
        {
            h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0, t3: "partial", requestId: id), claim: id);
            return "not a result";
        };
        await h.Tick();
        await h.Loop.CurrentRun;
        h.Engine.Checkin = () => Lines.Checkin(null);
        await h.Tick();
        var finished = Assert.Single(h.Reports[^1]["finished"]!.AsArray())!.AsObject();
        Assert.Equal(id, finished["requestId"]!.GetValue<string>());
        Assert.Equal("partial", finished["result"]!["t3"]!.GetValue<string>());
        Assert.Equal("not_run", finished["result"]!["security"]!.GetValue<string>());
    }

    [Fact]
    public async Task Finished_requests_an_older_tray_saved_are_reported_with_security_not_run()
    {
        var accepted = Fixture.RequestId();
        var partial = Fixture.RequestId();
        // tray-state.json as an older tray wrote it: each finished request with a security result.
        var file = $$"""
            {
              "runningRequestId": null,
              "finished": [
                { "requestId": "{{accepted}}", "t3": "accepted", "security": "failed" },
                { "requestId": "{{partial}}", "t3": "partial", "security": "accepted" }
              ],
              "lastAttemptAt": "2026-11-17T08:00:00+00:00"
            }
            """;
        using var h = new Harness(stateFile: file);
        await h.Tick();
        var finished = h.Reports[0]["finished"]!.AsArray().Select(f => f!.AsObject()).ToList();
        Assert.Equal([accepted, partial], finished.Select(f => f["requestId"]!.GetValue<string>()));
        Assert.Equal(["accepted", "partial"], finished.Select(f => f["result"]!["t3"]!.GetValue<string>()));
        Assert.All(finished, f => Assert.Equal("not_run", f["result"]!["security"]!.GetValue<string>()));
        Assert.Equal(["requestId", "result"], finished.SelectMany(f => f.Select(p => p.Key)).Distinct());
        Assert.Equal(["t3", "security"], finished.SelectMany(f => f["result"]!.AsObject().Select(p => p.Key)).Distinct());
    }

    [Fact]
    public async Task A_request_the_engine_does_not_hold_is_not_reported()
    {
        using var h = new Harness();
        var id = Fixture.RequestId();
        h.Engine.Checkin = () => Lines.Checkin(id);
        h.Engine.Run = _ => """{"type":"result","v":2,"command":"run","ok":false,"error":{"code":"request_not_claimed","message":"m"}}""";
        await h.Tick();
        await h.Loop.CurrentRun;
        h.Engine.Checkin = () => Lines.Checkin(null);
        await h.Tick();
        Assert.All(h.Reports, r => Assert.Empty(r["finished"]!.AsArray()));
    }

    [Fact]
    public async Task At_most_twenty_finished_requests_per_report()
    {
        var finished = Enumerable.Range(0, 25).Select(_ => new FinishedRequest(Fixture.RequestId(), PartResult.Accepted)).ToList();
        using var h = new Harness(state: new TrayState { Finished = finished });
        await h.Tick();
        Assert.Equal(20, h.Reports[0]["finished"]!.AsArray().Count);
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(5, h.Reports[1]["finished"]!.AsArray().Count);
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Empty(h.Reports[2]["finished"]!.AsArray());
    }

    [Fact]
    public async Task An_older_server_is_shown()
    {
        using var h = new Harness();
        h.Engine.Checkin = () => Fixture.Lines("checkin-older.jsonl")[0];
        await h.Tick();
        Assert.True(h.Loop.Snapshot.ServerOlder);
        Assert.Null(h.Loop.Snapshot.CheckinProblem);
    }

    [Fact]
    public async Task Holds_stop_runs_and_commands_for_an_update()
    {
        using var h = new Harness();
        h.Engine.Status = () => Lines.Status();
        using (h.Loop.HoldRuns())
        {
            await h.Tick();
            Assert.Empty(h.Runs);
            Assert.Single(h.Reports);
        }
        var hold = h.Loop.HoldAll();
        var calls = h.Engine.Calls.Count;
        await h.Advance(TimeSpan.FromMinutes(5));
        Assert.Equal(calls, h.Engine.Calls.Count);
        Assert.True(h.Loop.IsIdle);
        hold.Dispose();
        await h.Tick();
        Assert.Single(h.Runs);
        await h.Loop.CurrentRun;
    }

    [Fact]
    public async Task The_loop_runs_on_its_own_and_ends_on_quit()
    {
        using var h = new Harness();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var loop = h.Loop.RunAsync(cts.Token);
        await WaitFor(() => h.Reports.Count == 1);
        h.Time.Advance(TimeSpan.FromMinutes(1));
        await WaitFor(() => h.Reports.Count == 2);
        h.Loop.RequestQuit();
        await loop.WaitAsync(cts.Token);
    }

    private static async Task WaitFor(Func<bool> condition)
    {
        for (var i = 0; i < 400 && !condition(); i++)
            await Task.Delay(25);
        Assert.True(condition());
    }
}
