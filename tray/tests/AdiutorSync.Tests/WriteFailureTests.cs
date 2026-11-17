using AdiutorSync.Core;

namespace AdiutorSync.Tests;

// A settings file that cannot be written (result review R16) and what a settings field shows (R8).
public class WriteFailureTests
{
    [Fact]
    public async Task A_pause_that_cannot_be_written_changes_nothing_and_leaves_the_run_going()
    {
        using var h = new Harness(new TraySettings());
        h.Engine.RunGate = new TaskCompletionSource();
        h.Loop.SyncNow();
        await h.Tick();
        var file = h.Dir.File(TraySettings.FileName);
        var before = File.ReadAllText(file);
        // Another program holds the file (as a full disk or a missing permission would refuse the write).
        using (new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            Assert.False(h.Loop.PauseFor(TimeSpan.FromHours(1)));
            Assert.False(h.Loop.Resume());
            Assert.False(h.Loop.SaveSettings(new TraySettings { ScheduleHours = 12 }));
            var snapshot = h.Loop.Snapshot;
            Assert.False(snapshot.Paused);
            Assert.Equal(TraySettings.DefaultScheduleHours, snapshot.Settings.ScheduleHours);
            Assert.True(snapshot.SettingsNotSaved);
            Assert.NotNull(snapshot.Running);
            Assert.Contains(Texts.Load(Texts.English)["notice.notSaved"], TrayView.Build(snapshot, Texts.Load(Texts.English), _ => "").Notices);
        }
        Assert.Equal(before, File.ReadAllText(file));
        // Once the file can be written again, it works, and the notice goes.
        Assert.True(h.Loop.PauseFor(TimeSpan.FromHours(1)));
        Assert.True(h.Loop.Snapshot.Paused);
        Assert.False(h.Loop.Snapshot.SettingsNotSaved);
        h.Engine.RunGate.SetResult();
        await h.Loop.CurrentRun;
        Assert.Single(h.Runs);
    }

    private const string A = "https://a.example.com";
    private const string B = "https://b.example.com";
    private const string C = "https://c.example.com";

    [Fact]
    public void A_draft_survives_any_number_of_refreshes()
    {
        var field = new FieldState();
        var text = field.Refresh("", A, locked: false);
        Assert.Equal(A, text);
        text = B; // the owner types
        for (var i = 0; i < 3; i++)
            text = field.Refresh(text, A, locked: false);
        Assert.Equal(B, text);
    }

    [Fact]
    public void A_draft_survives_refreshes_after_a_failed_save()
    {
        var field = new FieldState();
        var text = field.Refresh("", A, locked: false);
        text = B;
        // The save failed: nothing marks the field saved, and the refresh the failure publishes keeps the draft.
        text = field.Refresh(text, A, locked: false);
        text = field.Refresh(text, A, locked: false);
        Assert.Equal(B, text);
        // Saved: the draft is the baseline, and later values show again.
        field.Saved(text);
        Assert.Equal(B, field.Refresh(text, B, locked: false));
        Assert.Equal(C, field.Refresh(B, C, locked: false));
    }

    [Fact]
    public void A_field_that_turns_out_locked_shows_the_value_commands_use()
    {
        var field = new FieldState();
        var text = field.Refresh("", A, locked: false);
        text = B;
        text = field.Refresh(text, A, locked: true);
        Assert.Equal(A, text);
        Assert.Equal(A, field.Refresh(B, A, locked: true));
    }

    [Fact]
    public void A_field_not_edited_follows_newer_values()
    {
        var field = new FieldState();
        var text = field.Refresh("", A, locked: false);
        text = field.Refresh(text, C, locked: false);
        Assert.Equal(C, text);
        Assert.Equal(A, field.Refresh(text, A, locked: false));
    }
}
