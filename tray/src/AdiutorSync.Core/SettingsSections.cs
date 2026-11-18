using System.Globalization;

namespace AdiutorSync.Core;

/// <summary>
/// The settings window's sections (Adiutor, T3, Sync) start closed, each with its state in its header. A section opens
/// on its own when it needs the owner: its connection is not there or has ended, or its disconnect is not finished.
/// </summary>
public static class SettingsSections
{
    /** Whether a connection's section needs the owner. An unknown state (no status read yet) does not. */
    public static bool NeedsAttention(ConnectionState? state, bool revocationPending) =>
        state is ConnectionState.NotConnected or ConnectionState.Ended || revocationPending;

    /** The Sync section's header: the schedule, and that no security data is sent without the overview folder. */
    public static string SyncSummary(Texts t, int hours, string? overviewDir)
    {
        var every = t["settings.schedule"] + " " + ScheduleChoice(t, hours);
        return string.IsNullOrWhiteSpace(overviewDir) ? every + " · " + t["settings.noOverview"] : every;
    }

    /** One choice of the schedule list: "1 hour", "4 hours". */
    public static string ScheduleChoice(Texts t, int hours) =>
        hours == 1 ? t["settings.hour"] : t.Format("settings.hours", ("n", hours.ToString(CultureInfo.CurrentCulture)));
}

/// <summary>
/// When a section opens on its own: once, at the moment it starts needing the owner, so a section the owner closed
/// stays closed until its state changes again.
/// </summary>
public sealed class SectionAttention
{
    private bool _needed;

    /** True when the section should open now: it needs the owner, and did not the last time. */
    public bool Update(bool needed)
    {
        var open = needed && !_needed;
        _needed = needed;
        return open;
    }
}
