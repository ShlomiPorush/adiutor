using Velopack;

namespace AdiutorSync;

public static class Program
{
    [STAThread]
    public static int Main()
    {
        // First of all: Velopack's install, update and uninstall hooks run here and end the process (Velopack's
        // documented start). Uninstalling removes the tray's start with Windows value; the data folder stays.
        VelopackApp.Build()
            .OnBeforeUninstallFastCallback(_ => StartWithWindows.Remove())
            .Run();

        // One tray per Windows session: a second start ends at once.
        using var single = new Mutex(initiallyOwned: true, @"Local\AdiutorSync.Tray", out var first);
        if (!first)
            return 0;
        var app = new App();
        return app.Run();
    }
}
