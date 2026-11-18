namespace AdiutorSync.Core;

/// <summary>
/// Decides whether an <c>ExecutablePath</c> value that Explorer stored under
/// <c>HKCU\Control Panel\NotifyIconSettings\&lt;id&gt;</c> belongs to this process.
/// </summary>
/// <remarks>
/// Explorer writes either a plain path or a path whose first segment is a known-folder GUID, for example
/// <c>{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}\AdiutorSync\current\AdiutorSync.exe</c> for LocalAppData. The GUID is
/// resolved through the given resolver and the whole path must match; a GUID that cannot be resolved never matches,
/// since the end of a path alone could name another copy of the exe.
/// </remarks>
public static class NotifyIconPathMatcher
{
    public static bool Matches(string? storedPath, string? processPath, Func<Guid, string?> resolveKnownFolder)
    {
        ArgumentNullException.ThrowIfNull(resolveKnownFolder);
        if (string.IsNullOrWhiteSpace(storedPath) || string.IsNullOrWhiteSpace(processPath))
            return false;

        var stored = Normalize(storedPath);
        var process = Normalize(processPath);
        if (!TrySplitKnownFolder(stored, out var folderId, out var remainder))
            return string.Equals(stored, process, StringComparison.OrdinalIgnoreCase);
        if (remainder.Length == 0)
            return false;

        string? folder;
        try
        {
            folder = resolveKnownFolder(folderId);
        }
#pragma warning disable CA1031 // A resolver that fails is a folder that cannot be resolved: no match.
        catch (Exception ex) when (ex is not OutOfMemoryException)
#pragma warning restore CA1031
        {
            folder = null;
        }

        return !string.IsNullOrWhiteSpace(folder)
            && string.Equals(Normalize(folder).TrimEnd('\\') + "\\" + remainder, process, StringComparison.OrdinalIgnoreCase);
    }

    private static bool TrySplitKnownFolder(string stored, out Guid folderId, out string remainder)
    {
        folderId = Guid.Empty;
        remainder = string.Empty;
        if (!stored.StartsWith('{'))
            return false;
        var close = stored.IndexOf('}', StringComparison.Ordinal);
        if (close < 0 || !Guid.TryParse(stored.AsSpan(0, close + 1), out folderId))
            return false;
        remainder = stored[(close + 1)..].TrimStart('\\');
        return true;
    }

    private static string Normalize(string path) => path.Trim().Trim('"').Replace('/', '\\');
}
