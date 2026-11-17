namespace AdiutorSync.Core;

/// <summary>
/// The engine's data folder, found the way the engine finds it (src/sync/oauth.ts, credentialsDir):
/// %LOCALAPPDATA%\adiutor, or %USERPROFILE%\AppData\Local\adiutor when LOCALAPPDATA is not set. The tray reads and
/// writes only its own files there (settings.json, tray-state.json, tray.log) and the engine's status through the
/// engine; it never reads the connection folder.
/// </summary>
public static class DataFolder
{
    public static string Resolve(Func<string, string?> env)
    {
        var profile = env("USERPROFILE");
        if (string.IsNullOrEmpty(profile))
            profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var local = env("LOCALAPPDATA");
        if (string.IsNullOrEmpty(local))
            local = Path.Combine(profile, "AppData", "Local");
        return Path.GetFullPath(Path.Combine(local, "adiutor"));
    }

    public static string Resolve() => Resolve(Environment.GetEnvironmentVariable);
}
