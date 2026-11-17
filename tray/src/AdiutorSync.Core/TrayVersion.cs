using System.Text.RegularExpressions;

namespace AdiutorSync.Core;

public static partial class TrayVersion
{
    /** The check-in's rule for the version (src/sync/checkin.ts): letters, digits, '.', '+' and '-', up to 50. */
    [GeneratedRegex("^[0-9A-Za-z.+-]{1,50}$")]
    private static partial Regex Allowed();

    /** The version the check-in sends: the build's informational version without build metadata. */
    public static string FromInformational(string? informational)
    {
        var version = (informational ?? "").Split('+')[0].Trim();
        return Allowed().IsMatch(version) ? version : "0.0.0";
    }

    public static bool IsAllowed(string version) => Allowed().IsMatch(version);
}
