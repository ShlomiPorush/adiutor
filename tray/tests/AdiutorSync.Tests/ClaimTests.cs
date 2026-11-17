using AdiutorSync.Core;

namespace AdiutorSync.Tests;

// A claim whose lease passes while the tray holds it (result review R4), and recovery that waits for a status it can
// trust (R9).
public class ClaimTests
{
    [Fact]
    public async Task A_claim_whose_lease_passed_while_paused_still_runs_after_resume_and_is_reported()
    {
        using var h = new Harness(new TraySettings { Pause = new Pause(null) });
        var id = Fixture.RequestId();
        h.Engine.Checkin = () => Lines.Checkin(id);
        await h.Tick();
        // Ten minutes on, Adiutor no longer answers it (unknown), but the engine keeps it (request.json, its status).
        h.Engine.Checkin = () => Lines.Checkin(null);
        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0.AddHours(-1)), claim: id);
        for (var i = 0; i < 12; i++)
            await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Empty(h.Runs);

        h.Engine.Run = _ => Lines.Run(Lines.Report(h.Time.GetUtcNow(), requestId: id));
        h.Loop.Resume();
        await h.Tick();
        Assert.Equal(["run", "--request", id], Assert.Single(h.Runs).Args);
        await h.Loop.CurrentRun;
        await h.Tick();
        // The late result goes to Adiutor, which keeps it for an unknown request.
        var finished = Assert.Single(h.Reports[^1]["finished"]!.AsArray())!.AsObject();
        Assert.Equal(id, finished["requestId"]!.GetValue<string>());
        // Once reported, it never runs again, though the status still shows the claim until the engine forgets it.
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Single(h.Runs);
    }

    [Fact]
    public async Task A_claim_waiting_behind_a_long_local_run_is_not_dropped()
    {
        using var h = new Harness();
        var id = Fixture.RequestId();
        h.Engine.RunGate = new TaskCompletionSource();
        h.Loop.SyncNow();
        await h.Tick();
        h.Engine.Checkin = () => Lines.Checkin(id);
        await h.Advance(TimeSpan.FromMinutes(1));
        h.Engine.Checkin = () => Lines.Checkin(null);
        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0.AddHours(-1)), claim: id);
        for (var i = 0; i < 12; i++)
            await h.Advance(TimeSpan.FromMinutes(1));
        h.Engine.RunGate.SetResult();
        await h.Loop.CurrentRun;
        h.Engine.RunGate = null;
        await h.Tick();
        Assert.Equal(["run", "--request", id], h.Runs[^1].Args);
        await h.Loop.CurrentRun;
    }

    [Fact]
    public async Task Recovery_keeps_the_request_until_a_status_can_be_read()
    {
        var id = Fixture.RequestId();
        using var h = new Harness(state: new TrayState { RunningRequestId = id });
        h.Engine.Status = () => """{"type":"result","v":1,"command":"status","ok":false,"error":{"code":"timeout","message":"m"}}""";
        await h.Tick();
        Assert.Equal(id, StateStore.Load(h.Dir.File(TrayState.FileName)).RunningRequestId);
        Assert.Empty(h.Runs);

        h.Engine.Status = () => Lines.Status(lastRun: Lines.Report(Harness.T0.AddMinutes(-30), t3: "accepted", security: "accepted", requestId: id), claim: id);
        await h.Advance(TimeSpan.FromMinutes(1));
        Assert.Null(StateStore.Load(h.Dir.File(TrayState.FileName)).RunningRequestId);
        var finished = Assert.Single(h.Reports[^1]["finished"]!.AsArray())!.AsObject();
        Assert.Equal(id, finished["requestId"]!.GetValue<string>());
        Assert.Empty(h.Runs);
    }
}
