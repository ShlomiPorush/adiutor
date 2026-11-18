using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using AdiutorSync.Core;
using Microsoft.Win32;

namespace AdiutorSync;

/// <summary>
/// Shows the tray's icon on the taskbar on Windows 11 instead of leaving it among the hidden icons, which a taskbar
/// without the hidden icon menu does not show at all.
/// </summary>
/// <remarks>
/// Explorer keeps one key per notification area icon under <c>HKCU\Control Panel\NotifyIconSettings</c>, with the
/// owning exe in <c>ExecutablePath</c>; a DWORD <c>IsPromoted</c> of 1 shows the icon at once. The value is written only
/// while it is absent: a 0 or 1 that exists is the owner's own choice in the taskbar settings and is never changed.
/// Windows 10 has no such key, so nothing happens there. Not a documented Windows interface: if Explorer changes it,
/// the icon is placed as Windows decides and the tray works as before.
/// </remarks>
internal static partial class TrayIconPromotion
{
    private const string NotifyIconSettingsKey = @"Control Panel\NotifyIconSettings";
    private const string ExecutablePathValue = "ExecutablePath";
    private const string IsPromotedValue = "IsPromoted";

    // Explorer writes the key shortly after the icon is created, sometimes a few seconds later on a busy sign-in. Every
    // round looks again: a key of an older icon of this exe being there says nothing about the current icon's key.
    private const int Rounds = 10;
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(1);

    /// <summary>Runs off the UI thread and never throws.</summary>
    public static void PromoteInBackground(ITrayLog log) => _ = Task.Run(() => PromoteAsync(log));

    private static async Task PromoteAsync(ITrayLog log)
    {
        try
        {
            var processPath = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(processPath) || !OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000))
                return;
            var found = false;
            for (var round = 1; round <= Rounds; round++)
            {
                found |= TryPromote(processPath, log);
                if (round < Rounds)
                    await Task.Delay(RetryDelay).ConfigureAwait(false);
            }
            if (!found)
                log.Info("tray icon: Explorer's settings key did not appear; placement unchanged");
        }
#pragma warning disable CA1031 // Showing the icon is a convenience: the tray goes on without it and says so in its log.
        catch (Exception e)
#pragma warning restore CA1031
        {
            log.Info($"tray icon: not shown on the taskbar ({e.GetType().Name})");
        }
    }

    /// <summary>
    /// Applies the rule to every key of this exe (older runs can leave several). True when a key of this exe was
    /// found, whether or not anything needed writing.
    /// </summary>
    private static bool TryPromote(string processPath, ITrayLog log)
    {
        using var root = Registry.CurrentUser.OpenSubKey(NotifyIconSettingsKey, writable: false);
        if (root is null)
            return false;
        var found = false;
        foreach (var name in root.GetSubKeyNames())
        {
            try
            {
                using var iconKey = root.OpenSubKey(name, writable: false);
                if (iconKey?.GetValue(ExecutablePathValue) is not string storedPath
                    || !NotifyIconPathMatcher.Matches(storedPath, processPath, KnownFolderPath))
                    continue;
                found = true;
                if (iconKey.GetValue(IsPromotedValue) is not null)
                    continue;
                using var writable = root.OpenSubKey(name, writable: true);
                if (writable is null || writable.GetValue(IsPromotedValue) is not null)
                    continue;
                writable.SetValue(IsPromotedValue, 1, RegistryValueKind.DWord);
                log.Info("tray icon: shown on the taskbar");
            }
            catch (Exception e) when (e is SecurityException or UnauthorizedAccessException or IOException)
            {
                log.Info($"tray icon: a settings key could not be changed ({e.GetType().Name})");
            }
        }
        return found;
    }

    private static string? KnownFolderPath(Guid folderId)
    {
        var result = SHGetKnownFolderPath(folderId, 0, IntPtr.Zero, out var pointer);
        try
        {
            return result == 0 ? Marshal.PtrToStringUni(pointer) : null;
        }
        finally
        {
            if (pointer != IntPtr.Zero)
                Marshal.FreeCoTaskMem(pointer);
        }
    }

    [LibraryImport("shell32.dll")]
    private static partial int SHGetKnownFolderPath(in Guid rfid, uint dwFlags, IntPtr hToken, out IntPtr ppszPath);
}
