using System.Globalization;

namespace AdiutorSync.Core;

public static class Times
{
    /** ISO 8601 in UTC with milliseconds, as JavaScript's toISOString writes it, which the engine reads. */
    public static string Iso(DateTimeOffset value) =>
        value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
}
