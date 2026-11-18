namespace AdiutorSync.Core;

/// <summary>What the icon's tooltip and the panel show for one snapshot, in the chosen language.</summary>
public sealed record PanelView(
    IconState Icon,
    string State,
    string T3,
    string LastRun,
    string LastGood,
    string NextRun,
    IReadOnlyList<string> Notices,
    bool CanSyncNow,
    bool Paused,
    bool CanPause,
    string? AdiutorUrl,
    string Tooltip);

/// <summary>
/// The panel's content from a snapshot (the plan, section 4, "Tray"): the state, the last run's T3 result and its time, the last good sync, the next scheduled run, and the notices. Times come through the caller's format
/// (local time in Windows' format in the app).
/// </summary>
public static class TrayView
{
    /** NotifyIcon's limit for its tooltip. */
    public const int TooltipMax = 127;

    /** The left-to-right mark: a strong left-to-right character that WPF honours (its embedding controls it ignores). */
    public const string LeftToRightMark = "\u200E";

    public static PanelView Build(TraySnapshot s, Texts t, Func<DateTimeOffset, string> time)
    {
        var icon = IconStates.Map(s);
        var status = s.Status;
        var last = status?.LastRun;
        var lastGood = status?.LastGoodSyncAt ?? last?.LastGoodSyncAt;

        string nextRun;
        if (s.NextRunAt is { } next)
            nextRun = time(next);
        else if (s.Paused)
            nextRun = t["panel.afterResume"];
        else
            nextRun = t["panel.noSchedule"];

        var notices = new List<string>();
        if (s.SettingsNotSaved)
            notices.Add(t["notice.notSaved"]);
        if (s.UpdateReady)
            notices.Add(t["panel.updateReady"]);
        if (s.EngineMissing)
            notices.Add(t["notice.engineMissing"]);
        else if (s.StatusProblem is { } problem)
            notices.Add(t.Format("notice.status", ("code", problem)));
        if (status is not null && (status.Adiutor.State != ConnectionState.Connected || status.T3.State != ConnectionState.Connected))
            notices.Add(t["notice.connect"]);
        if (status is { SettingsProblems.Count: > 0 })
            notices.Add(t["notice.settings"]);
        if (s.RunningElsewhereSince is not null)
            notices.Add(t["notice.elsewhere"]);
        if (s.LastStartBusy && s.Running is null)
            notices.Add(t["notice.busy"]);
        if (s.ServerOlder)
            notices.Add(t["notice.serverOlder"]);
        else if (s.CheckinProblem is { } code)
            notices.Add(t.Format("notice.checkin", ("code", code)));

        var state = StateText(s, icon, t, time);
        var good = lastGood is { } g ? t.Format("tooltip.lastGood", ("time", time(g))) : t["tooltip.never"];
        return new PanelView(
            icon,
            state,
            last is null ? t["panel.noRun"] : PartText(last.T3.Result, t),
            last is null ? t["panel.never"] : time(last.FinishedAt),
            lastGood is { } at ? time(at) : t["panel.never"],
            nextRun,
            notices,
            CanSyncNow: !s.EngineMissing && status?.Adiutor.State == ConnectionState.Connected && s.Running is null && s.RunningElsewhereSince is null && !s.Quitting,
            Paused: s.Paused,
            CanPause: !s.Quitting,
            AdiutorUrl: OpenableUrl(status?.Adiutor.Url ?? s.Settings.AdiutorUrl),
            Tooltip: Clip($"{t["appName"]}\n{state}\n{good}", TooltipMax));
    }

    public static string PartText(PartResult part, Texts t) => part switch
    {
        PartResult.Unknown => t["part.unknown"],
        _ => t["part." + EngineOutput.PartName(part)],
    };

    private static string StateText(TraySnapshot s, IconState icon, Texts t, Func<DateTimeOffset, string> time) => icon switch
    {
        IconState.Syncing when s.Quitting => t["state.finishing"],
        IconState.Syncing => t["state.syncing"],
        IconState.UpdateReady => t["state.updateReady"],
        IconState.NotConnected when s.EngineMissing => t["state.engineMissing"],
        IconState.NotConnected when s.Status is null => t["state.noStatus"],
        IconState.NotConnected when s.Status.Adiutor.State != ConnectionState.Connected => t["state.notConnectedAdiutor"],
        IconState.NotConnected => t["state.notConnectedT3"],
        IconState.Paused when s.Settings.Pause?.Until is { } until => t.Format("state.pausedUntil", ("time", time(until))),
        IconState.Paused => t["state.paused"],
        IconState.Problem => t["state.problem"],
        _ when s.Status?.LastRun is null => t["state.noRunYet"],
        _ => t["state.synced"],
    };

    /**
     * Local time in Windows' own date and time format. In Hebrew the date and the time are kept left to right as one
     * piece (between left-to-right marks), so a right-to-left line does not swap them.
     */
    public static string LocalTime(DateTimeOffset at, Texts t, System.Globalization.CultureInfo culture)
    {
        return LeftToRight(at.ToLocalTime().ToString("g", culture), t);
    }

    /** A left-to-right piece (a time, a version) kept in its order inside a right-to-left line. */
    public static string LeftToRight(string text, Texts t) =>
        t.RightToLeft ? LeftToRightMark + text + LeftToRightMark : text;

    /** Only an http or https address is opened in the browser. */
    public static string? OpenableUrl(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp)
            ? uri.AbsoluteUri
            : null;

    private static string Clip(string text, int max) => text.Length <= max ? text : text[..(max - 1)] + "…";
}
