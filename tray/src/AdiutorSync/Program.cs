using Velopack;

namespace AdiutorSync;

public static class Program
{
    private const string MutexName = @"Local\AdiutorSync.Tray";
    private const string ShowEventName = @"Local\AdiutorSync.ShowPanel";

    [STAThread]
    public static int Main()
    {
        // First of all: Velopack's install, update and uninstall hooks run here and end the process (Velopack's
        // documented start). Uninstalling removes the tray's start with Windows value; the data folder stays.
        VelopackApp.Build()
            .OnBeforeUninstallFastCallback(_ => StartWithWindows.Remove())
            .Run();

        // One tray per Windows session. Starting it again (from the Start menu) opens the running tray's panel.
        using var show = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        using var single = new Mutex(initiallyOwned: true, MutexName, out var first);
        if (!first)
        {
            show.Set();
            return 0;
        }
        var app = new App(show);
        return app.Run();
    }
}
