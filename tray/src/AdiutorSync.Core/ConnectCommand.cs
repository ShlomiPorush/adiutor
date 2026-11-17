namespace AdiutorSync.Core;

/// <summary>
/// The engine's `connect` as the settings window runs it. Always with --no-open: a browser the engine started would be
/// a child of the engine, inside the tray's Job Object, and Quit or an update would end it with the job. The tray opens
/// the approval page itself, from its own process, outside the job.
/// </summary>
public static class ConnectCommand
{
    public const int NameMax = 60;

    public static List<string> Args(string machineName, string url, bool replace)
    {
        var name = $"Adiutor Sync ({machineName})";
        if (name.Length > NameMax)
            name = name[..NameMax];
        List<string> args = ["connect", "--name", name, "--url", url, "--no-open"];
        if (replace)
            args.Add("--replace");
        return args;
    }
}
