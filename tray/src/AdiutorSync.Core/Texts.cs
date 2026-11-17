using System.Globalization;
using System.Reflection;
using System.Text.Json;

namespace AdiutorSync.Core;

/// <summary>
/// The tray's user-visible text: the `tray` section of the repository's locale files (src/shared/locales/en.json and
/// he.json, embedded at build time), so Hebrew stays in he.json alone and the guards keep both files' keys aligned.
/// Placeholders are written {name}.
/// </summary>
public sealed class Texts
{
    public const string Hebrew = "he";
    public const string English = "en";

    private readonly IReadOnlyDictionary<string, string> _map;

    private Texts(string language, IReadOnlyDictionary<string, string> map)
    {
        Language = language;
        _map = map;
    }

    public string Language { get; }

    public bool RightToLeft => Language == Hebrew;

    /** The language the owner chose, or Windows' display language: Hebrew when it is Hebrew, otherwise English. */
    public static string Choose(string? setting, CultureInfo windows) =>
        setting is Hebrew or English ? setting : windows.TwoLetterISOLanguageName == Hebrew ? Hebrew : English;

    public static Texts Load(string language)
    {
        var lang = language == Hebrew ? Hebrew : English;
        return new Texts(lang, Read(lang));
    }

    public string this[string key] => _map.TryGetValue(key, out var value) ? value : key;

    /** The text with each {name} replaced by its value. */
    public string Format(string key, params (string Name, string Value)[] values)
    {
        var text = this[key];
        foreach (var (name, value) in values)
            text = text.Replace("{" + name + "}", value, StringComparison.Ordinal);
        return text;
    }

    /** Every key of the tray section of a locale file, flattened with dots ("panel.syncNow"). */
    internal static Dictionary<string, string> Read(string language)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"locales.{language}.json")
            ?? throw new InvalidOperationException($"locale {language} is not embedded");
        using var doc = JsonDocument.Parse(stream);
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        if (doc.RootElement.TryGetProperty("tray", out var tray))
            Flatten(tray, "", map);
        return map;
    }

    private static void Flatten(JsonElement node, string prefix, Dictionary<string, string> map)
    {
        foreach (var property in node.EnumerateObject())
        {
            var key = prefix.Length == 0 ? property.Name : prefix + "." + property.Name;
            if (property.Value.ValueKind == JsonValueKind.Object)
                Flatten(property.Value, key, map);
            else if (property.Value.ValueKind == JsonValueKind.String)
                map[key] = property.Value.GetString()!;
        }
    }
}
