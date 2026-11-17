using Microsoft.Win32;
using Velopack.Locators;

namespace AdiutorSync;

/// <summary>
/// Start with Windows (on by default; the plan, "Settings window"): a value in the user's Run key
/// (HKCU\Software\Microsoft\Windows\CurrentVersion\Run) naming the installed tray. Velopack's runtime shortcut helper
/// is obsolete in 1.2, and its pack-time Startup shortcut cannot be turned off by the owner, so the Run key it is (the
/// brief allows either). Only an installed tray writes it; a development build never does. Uninstalling removes it
/// (Velopack's uninstall hook in Program).
/// </summary>
internal static class StartWithWindows
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "AdiutorSync";

    public static bool Available =>
        VelopackLocator.IsCurrentSet && VelopackLocator.Current.CurrentlyInstalledVersion is not null && !VelopackLocator.Current.IsPortable;

    public static void Apply(bool on)
    {
        if (!Available || Environment.ProcessPath is not { } exe)
            return;
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (on)
            key.SetValue(ValueName, $"\"{exe}\"", RegistryValueKind.String);
        else
            key.DeleteValue(ValueName, throwOnMissingValue: false);
    }

    public static void Remove()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
        key?.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}
