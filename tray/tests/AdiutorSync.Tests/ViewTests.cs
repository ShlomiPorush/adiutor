using System.Text.RegularExpressions;
using AdiutorSync.Core;

namespace AdiutorSync.Tests;

// The text the windows show: the tray section of the locale files, the panel and the tooltip for each state, and the
// address rule the settings window checks.
public partial class ViewTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-11-17T09:00:00Z", CultureInfo.InvariantCulture);

    private static string Time(DateTimeOffset at) => at.UtcDateTime.ToString("HH:mm", CultureInfo.InvariantCulture);

    [GeneratedRegex(@"\{[a-z]+\}")]
    private static partial Regex Placeholder();

    [Fact]
    public void Both_languages_have_the_same_keys_and_placeholders()
    {
        var en = Texts.Read(Texts.English);
        var he = Texts.Read(Texts.Hebrew);
        Assert.NotEmpty(en);
        Assert.Equal(en.Keys.Order(StringComparer.Ordinal), he.Keys.Order(StringComparer.Ordinal));
        foreach (var key in en.Keys)
        {
            var a = Placeholder().Matches(en[key]).Select(m => m.Value).Order(StringComparer.Ordinal);
            var b = Placeholder().Matches(he[key]).Select(m => m.Value).Order(StringComparer.Ordinal);
            Assert.True(a.SequenceEqual(b), $"placeholders differ in {key}");
        }
    }

    [Theory]
    [InlineData(null, "he-IL", "he")]
    [InlineData(null, "en-US", "en")]
    [InlineData(null, "fr-FR", "en")]
    [InlineData("en", "he-IL", "en")]
    [InlineData("he", "en-US", "he")]
    [InlineData("xx", "he-IL", "he")]
    public void Language_follows_the_setting_or_windows(string? setting, string windows, string expected) =>
        Assert.Equal(expected, Texts.Choose(setting, CultureInfo.GetCultureInfo(windows)));

    public static TheoryData<string> States() =>
        ["synced", "never", "syncing", "quitting", "problem", "paused", "pausedUntil", "adiutor", "t3", "missing", "noStatus", "update", "busy", "older", "checkin"];

    private static TraySnapshot Snapshot(string state)
    {
        var good = new RunReport(Now.AddHours(-1), Now.AddMinutes(-57), false, null,
            new RunPart(PartResult.Accepted, null), new RunPart(PartResult.Accepted, null), Now.AddMinutes(-57));
        var bad = good with { Security = new RunPart(PartResult.Failed, "push_failed"), LastGoodSyncAt = Now.AddDays(-1) };
        EngineStatus Status(ConnectionState adiutor = ConnectionState.Connected, ConnectionState t3 = ConnectionState.Connected, RunReport? last = null) =>
            new(new AdiutorConnection(adiutor, "https://adiutor.example.com", false), new T3Connection(t3, null, null, false),
                last ?? good, (last ?? good).LastGoodSyncAt, null, null, []);
        var settings = new TraySettings();
        var s = new TraySnapshot { Settings = settings, Status = Status(), NextRunAt = Now.AddHours(2) };
        return state switch
        {
            "synced" => s,
            "never" => s with { Status = Status() with { LastRun = null, LastGoodSyncAt = null } },
            "syncing" => s with { Running = new RunningRun(RunKind.Manual, null, Now) },
            "quitting" => s with { Running = new RunningRun(RunKind.Scheduled, null, Now), Quitting = true },
            "problem" => s with { Status = Status(last: bad) },
            "paused" => s with { Paused = true, NextRunAt = null, Settings = settings with { Pause = new Pause(null) } },
            "pausedUntil" => s with { Paused = true, Settings = settings with { Pause = new Pause(Now.AddHours(4)) } },
            "adiutor" => s with { Status = Status(adiutor: ConnectionState.Ended) },
            "t3" => s with { Status = Status(t3: ConnectionState.NotConnected) },
            "missing" => new TraySnapshot { Settings = settings, EngineMissing = true },
            "noStatus" => new TraySnapshot { Settings = settings, StatusProblem = "timeout" },
            "update" => s with { UpdateReady = true },
            "busy" => s with { LastStartBusy = true },
            "older" => s with { ServerOlder = true },
            "checkin" => s with { CheckinProblem = "outcome_unknown" },
            _ => throw new ArgumentException(state),
        };
    }

    [Theory]
    [MemberData(nameof(States))]
    public void Every_state_has_text_in_both_languages(string state)
    {
        foreach (var language in new[] { Texts.English, Texts.Hebrew })
        {
            var t = Texts.Load(language);
            var view = TrayView.Build(Snapshot(state), t, Time);
            var shown = new[] { view.State, view.T3, view.Security, view.LastRun, view.LastGood, view.NextRun, view.Tooltip }.Concat(view.Notices);
            foreach (var text in shown)
            {
                Assert.False(string.IsNullOrWhiteSpace(text));
                // A key shown as it is means the text is missing.
                Assert.DoesNotMatch(@"^[a-z]+\.[a-zA-Z_.]+$", text);
                Assert.DoesNotContain("{", text, StringComparison.Ordinal);
            }
            Assert.True(view.Tooltip.Length <= TrayView.TooltipMax);
        }
    }

    [Fact]
    public void Panel_shows_the_parts_times_and_notices()
    {
        var t = Texts.Load(Texts.English);
        var view = TrayView.Build(Snapshot("problem"), t, Time);
        Assert.Equal(IconState.Problem, view.Icon);
        Assert.Equal("The last sync had a problem", view.State);
        Assert.Equal("accepted", view.T3);
        Assert.Equal("failed", view.Security);
        Assert.Equal("08:03", view.LastRun);
        Assert.Equal("09:00", view.LastGood);
        Assert.Equal("11:00", view.NextRun);
        Assert.Equal("Adiutor Sync\nThe last sync had a problem\nLast good sync: 09:00", view.Tooltip);
        Assert.Equal("https://adiutor.example.com/", view.AdiutorUrl);

        view = TrayView.Build(Snapshot("pausedUntil"), t, Time);
        Assert.Equal("Paused until 13:00", view.State);
        Assert.True(view.Paused);
        view = TrayView.Build(Snapshot("paused"), t, Time);
        Assert.Equal("After you resume", view.NextRun);

        view = TrayView.Build(Snapshot("quitting"), t, Time);
        Assert.Equal("Finishing the run, then closing", view.State);
        Assert.False(view.CanSyncNow);

        view = TrayView.Build(Snapshot("adiutor"), t, Time);
        Assert.False(view.CanSyncNow);
        Assert.True(TrayView.Build(Snapshot("synced"), t, Time).CanSyncNow);

        view = TrayView.Build(Snapshot("checkin"), t, Time);
        Assert.Contains("Could not report to Adiutor (outcome_unknown). It tries again in a minute.", view.Notices);
        view = TrayView.Build(Snapshot("never"), t, Time);
        Assert.Equal("No sync yet", view.State);
        Assert.Equal("Never", view.LastGood);
    }

    [Fact]
    public void Tooltip_is_clipped_to_the_notify_icon_limit()
    {
        var t = Texts.Load(Texts.Hebrew);
        var view = TrayView.Build(Snapshot("synced"), t, _ => new string('x', 200));
        Assert.Equal(TrayView.TooltipMax, view.Tooltip.Length);
    }

    [Fact]
    public void Hebrew_keeps_a_date_and_time_in_order()
    {
        var culture = CultureInfo.GetCultureInfo("he-IL");
        var he = TrayView.LocalTime(Now, Texts.Load(Texts.Hebrew), culture);
        var en = TrayView.LocalTime(Now, Texts.Load(Texts.English), culture);
        Assert.Equal('\u200E' + en + '\u200E', he);
        Assert.DoesNotContain("\u200E", en, StringComparison.Ordinal);
        Assert.Equal("\u200E", TrayView.LeftToRightMark);
    }

    [Theory]
    [InlineData("https://adiutor.example.com", "https://adiutor.example.com")]
    [InlineData(" https://Adiutor.Example.com/ ", "https://adiutor.example.com")]
    [InlineData("https://adiutor.example.com:8443", "https://adiutor.example.com:8443")]
    [InlineData("http://localhost:8090", "http://localhost:8090")]
    [InlineData("http://127.0.0.1:3773", "http://127.0.0.1:3773")]
    [InlineData("http://[::1]:3773", "http://[::1]:3773")]
    [InlineData("http://adiutor.example.com", null)]
    [InlineData("https://adiutor.example.com/app", null)]
    [InlineData("https://adiutor.example.com/?a=1", null)]
    [InlineData("https://user:pw@adiutor.example.com", null)]
    [InlineData("ftp://adiutor.example.com", null)]
    [InlineData("adiutor.example.com", null)]
    [InlineData("", null)]
    public void Addresses_follow_the_engine_rule(string raw, string? origin) => Assert.Equal(origin, Addresses.Origin(raw));

    [Theory]
    [InlineData("https://adiutor.example.com", "https://adiutor.example.com/")]
    [InlineData("javascript:alert(1)", null)]
    [InlineData("file:///C:/Windows", null)]
    [InlineData(null, null)]
    public void Only_web_addresses_open(string? url, string? opened) => Assert.Equal(opened, TrayView.OpenableUrl(url));
}

public class ConnectCommandTests
{
    [Fact]
    public void Connect_never_lets_the_engine_open_the_browser()
    {
        var args = ConnectCommand.Args("PC-1", "https://adiutor.example.com", replace: false);
        Assert.Equal(["connect", "--name", "Adiutor Sync (PC-1)", "--url", "https://adiutor.example.com", "--no-open"], args);
        Assert.Contains("--replace", ConnectCommand.Args("PC-1", "https://adiutor.example.com", replace: true));
        Assert.Equal(ConnectCommand.NameMax, ConnectCommand.Args(new string('x', 80), "https://adiutor.example.com", false)[2].Length);
    }
}
