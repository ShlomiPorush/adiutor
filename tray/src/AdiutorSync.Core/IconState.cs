namespace AdiutorSync.Core;

/// <summary>The tray icon's states (the plan, section 4, "Tray").</summary>
public enum IconState
{
    Synced,
    Syncing,
    Problem,
    Paused,
    NotConnected,
    UpdateReady,
}

public static class IconStates
{
    /**
     * One state for the icon, in this order: a run going (the tray's or one from the command line; also while
     * quitting), an update ready to install, a connection missing (Adiutor or T3, or the engine cannot be read), paused,
     * the last run had a problem, synced. A tray with no run yet shows synced; the panel says there was none.
     */
    public static IconState Map(TraySnapshot s)
    {
        if (s.Running is not null || s.RunningElsewhereSince is not null)
            return IconState.Syncing;
        if (s.UpdateReady)
            return IconState.UpdateReady;
        if (s.EngineMissing || s.Status is null)
            return IconState.NotConnected;
        if (s.Status.Adiutor.State != ConnectionState.Connected || s.Status.T3.State != ConnectionState.Connected)
            return IconState.NotConnected;
        if (s.Paused)
            return IconState.Paused;
        if (s.Status.LastRun is { } last && !last.IsGood)
            return IconState.Problem;
        return IconState.Synced;
    }
}
