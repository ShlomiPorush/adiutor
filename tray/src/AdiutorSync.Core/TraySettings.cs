using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AdiutorSync.Core;

/// <summary>The tray's pause: until a time, or until resumed (Until null).</summary>
public sealed record Pause(DateTimeOffset? Until)
{
    /** Whether this pause holds at a time: one whose time passed is no pause, as the engine reads it. */
    public bool HoldsAt(DateTimeOffset now) => Until is not { } until || until > now;
}

/// <summary>
/// The settings file settings.json in the engine's data folder (docs/sync.md, "Settings"). The tray writes it and the
/// engine reads its own keys from it (adiutorUrl, t3CliPath, t3Url, pause). The other keys are the tray's
/// (scheduleHours, language, startWithWindows, enginePath). No secret is ever in it. Keys the tray does not know are
/// kept as they are when it writes the file (an overviewDir an older tray wrote stays, and the engine ignores it).
/// </summary>
public sealed record TraySettings
{
    public const string FileName = "settings.json";
    public const int DefaultScheduleHours = 3;
    public static readonly int[] ScheduleChoices = [1, 2, 3, 4, 6, 8, 12, 24];

    public string? AdiutorUrl { get; init; }
    public string? T3CliPath { get; init; }
    public string? T3Url { get; init; }
    public Pause? Pause { get; init; }

    /** Hours between scheduled runs (owner's decision D-T3: every 3 hours by default). */
    public int ScheduleHours { get; init; } = DefaultScheduleHours;

    /** "he" or "en"; null follows Windows' display language. */
    public string? Language { get; init; }

    /** Start with Windows; on unless the owner turned it off. */
    public bool StartWithWindows { get; init; } = true;

    /** The engine bundle (adiutor-sync.js) for a development build; an installed tray uses its own. */
    public string? EnginePath { get; init; }

    public TimeSpan Interval => TimeSpan.FromHours(ScheduleHours);

    public bool IsPaused(DateTimeOffset now) => Pause is { } pause && pause.HoldsAt(now);
}

public static class SettingsStore
{
    /** Reads the file; a missing file gives the defaults, a damaged one the defaults and a problem, never a guess. */
    public static (TraySettings Settings, bool Damaged) Load(string path)
    {
        var text = JsonFile.Read(path);
        if (text is null)
            return (new TraySettings(), false);
        JsonObject? root;
        try
        {
            root = JsonNode.Parse(text.TrimStart('\uFEFF')) as JsonObject;
        }
        catch (JsonException)
        {
            root = null;
        }
        if (root is null)
            return (new TraySettings(), true);
        return (FromJson(root), false);
    }

    /**
     * Writes the settings in one step. Keys the tray does not know are kept from the file on disk, unless the file is
     * damaged, in which case it is replaced.
     */
    public static void Save(string path, TraySettings settings)
    {
        JsonObject root;
        try
        {
            root = JsonFile.Read(path) is { } text && JsonNode.Parse(text.TrimStart('\uFEFF')) is JsonObject existing
                ? existing
                : [];
        }
        catch (JsonException)
        {
            root = [];
        }
        SetText(root, "adiutorUrl", settings.AdiutorUrl);
        SetText(root, "t3CliPath", settings.T3CliPath);
        SetText(root, "t3Url", settings.T3Url);
        if (settings.Pause is { } pause)
            root["pause"] = new JsonObject { ["until"] = pause.Until is { } until ? Times.Iso(until) : null };
        else
            root.Remove("pause");
        root["scheduleHours"] = settings.ScheduleHours;
        SetText(root, "language", settings.Language);
        root["startWithWindows"] = settings.StartWithWindows;
        SetText(root, "enginePath", settings.EnginePath);
        JsonFile.WriteAtomic(path, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
    }

    internal static TraySettings FromJson(JsonObject root)
    {
        string? Text(string name) =>
            root[name] is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;

        // Read as the engine reads it (src/sync/settings.ts): a pause object holds, until its time when it has one,
        // and otherwise until resumed.
        Pause? pause = null;
        if (root["pause"] is JsonObject p)
        {
            DateTimeOffset? until = p["until"] is JsonValue uv && uv.TryGetValue<string>(out var s) &&
                DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at)
                ? at
                : null;
            pause = new Pause(until);
        }
        var hours = root["scheduleHours"] is JsonValue h && h.TryGetValue<int>(out var n) && TraySettings.ScheduleChoices.Contains(n)
            ? n
            : TraySettings.DefaultScheduleHours;
        var language = Text("language") is "he" or "en" ? Text("language") : null;
        var start = root["startWithWindows"] is not JsonValue sv || !sv.TryGetValue<bool>(out var b) || b;
        return new TraySettings
        {
            AdiutorUrl = Text("adiutorUrl"),
            T3CliPath = Text("t3CliPath"),
            T3Url = Text("t3Url"),
            Pause = pause,
            ScheduleHours = hours,
            Language = language,
            StartWithWindows = start,
            EnginePath = Text("enginePath"),
        };
    }

    private static void SetText(JsonObject root, string name, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            root.Remove(name);
        else
            root[name] = value.Trim();
    }
}
