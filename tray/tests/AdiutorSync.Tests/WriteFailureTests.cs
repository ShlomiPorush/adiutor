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

    [Theory]
    // Before the first status (nothing shown yet): the value.
    [InlineData("", null, "https://a.example.com", false, "https://a.example.com")]
    // The owner typed B; a newer value of an editable field leaves the draft alone.
    [InlineData("https://b.example.com", "", "https://a.example.com", false, "https://b.example.com")]
    // The owner typed B, then the environment turns out to set A: the locked field shows A, the draft goes.
    [InlineData("https://b.example.com", "", "https://a.example.com", true, "https://a.example.com")]
    // Not edited since it was shown (or saved): the newer value.
    [InlineData("https://b.example.com", "https://b.example.com", "https://c.example.com", false, "https://c.example.com")]
    public void A_field_shows_what_commands_use(string current, string? lastShown, string value, bool locked, string shown) =>
        Assert.Equal(shown, EffectiveSettings.FieldText(current, lastShown, value, locked));
}
