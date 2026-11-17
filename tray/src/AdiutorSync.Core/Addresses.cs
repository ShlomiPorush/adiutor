using System.Text.RegularExpressions;

namespace AdiutorSync.Core;

/// <summary>
/// The engine's rule for Adiutor's and T3's addresses (src/sync/oauth.ts, issuerOf): the address alone, https, or
/// http on this computer. The settings window checks it before it saves, so the engine never meets an address it
/// would refuse.
/// </summary>
public static partial class Addresses
{
    private static readonly string[] Loopback = ["127.0.0.1", "[::1]", "localhost"];

    [GeneratedRegex(@"^https?://(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:[1-9][0-9]{0,4})?$")]
    private static partial Regex SafeOrigin();

    /** The origin (scheme, host and port) of an address the engine accepts, or null. */
    public static string? Origin(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw) || !Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var uri))
            return null;
        var host = uri.HostNameType == UriHostNameType.IPv6 ? $"[{uri.IdnHost.Trim('[', ']')}]" : uri.IdnHost;
        var loopback = Loopback.Contains(host, StringComparer.OrdinalIgnoreCase);
        if (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && loopback))
            return null;
        if (uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.AbsolutePath != "/")
            return null;
        var origin = uri.IsDefaultPort ? $"{uri.Scheme}://{host}" : $"{uri.Scheme}://{host}:{uri.Port}";
        origin = origin.ToLowerInvariant();
        return SafeOrigin().IsMatch(origin) ? origin : null;
    }
}
