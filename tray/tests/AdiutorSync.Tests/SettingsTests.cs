using System.Text.Json.Nodes;
using AdiutorSync.Core;

namespace AdiutorSync.Tests;

// settings.json in the engine's format (docs/sync.md, "Settings"; src/sync/settings.ts readSettingsFile).
public class SettingsTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-11-17T10:00:00Z", CultureInfo.InvariantCulture);

    [Fact]
    public void Missing_file_gives_the_defaults()
    {
        using var dir = new TempFolder();
        var (settings, damaged) = SettingsStore.Load(dir.File("settings.json"));
        Assert.False(damaged);
        Assert.Equal(3, settings.ScheduleHours);
        Assert.True(settings.StartWithWindows);
        Assert.Null(settings.Pause);
        Assert.False(settings.IsPaused(Now));
    }

    [Fact]
    public void Damaged_file_gives_the_defaults_and_says_so()
    {
        using var dir = new TempFolder();
        File.WriteAllText(dir.File("settings.json"), "[not an object]");
        var (settings, damaged) = SettingsStore.Load(dir.File("settings.json"));
        Assert.True(damaged);
        Assert.Equal(TraySettings.DefaultScheduleHours, settings.ScheduleHours);
    }

    [Fact]
    public void Pause_for_a_time_is_written_as_the_engine_reads_it()
    {
        using var dir = new TempFolder();
        var path = dir.File("settings.json");
        SettingsStore.Save(path, new TraySettings { Pause = new Pause(Now.AddHours(1)) });
        var root = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        Assert.Equal("2026-11-17T11:00:00.000Z", root["pause"]!["until"]!.GetValue<string>());
        var back = SettingsStore.Load(path).Settings;
        Assert.True(back.IsPaused(Now));
        Assert.False(back.IsPaused(Now.AddHours(1)));
    }

    [Fact]
    public void Pause_until_resumed_is_until_null()
    {
        using var dir = new TempFolder();
        var path = dir.File("settings.json");
        SettingsStore.Save(path, new TraySettings { Pause = new Pause(null) });
        var root = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        Assert.True(root["pause"]!.AsObject().ContainsKey("until"));
        Assert.Null(root["pause"]!["until"]);
        Assert.True(SettingsStore.Load(path).Settings.IsPaused(Now.AddYears(5)));
    }

    [Fact]
    public void Resume_removes_the_pause()
    {
        using var dir = new TempFolder();
        var path = dir.File("settings.json");
        SettingsStore.Save(path, new TraySettings { Pause = new Pause(null) });
        SettingsStore.Save(path, SettingsStore.Load(path).Settings with { Pause = null });
        Assert.False(JsonNode.Parse(File.ReadAllText(path))!.AsObject().ContainsKey("pause"));
    }

    [Fact]
    public void A_pause_time_that_cannot_be_read_holds_until_resumed_as_in_the_engine()
    {
        using var dir = new TempFolder();
        var path = dir.File("settings.json");
        File.WriteAllText(path, """{"pause":{"until":"soon"}}""");
        var settings = SettingsStore.Load(path).Settings;
        Assert.Null(settings.Pause!.Until);
        Assert.True(settings.IsPaused(Now));
    }

    [Fact]
    public void Engine_keys_are_written_and_unknown_keys_kept()
    {
        using var dir = new TempFolder();
        var path = dir.File("settings.json");
        File.WriteAllText(path, """{"someday":{"x":1},"t3Url":"http://127.0.0.1:3773"}""");
        var settings = SettingsStore.Load(path).Settings with
        {
            AdiutorUrl = " https://adiutor.example.com ",
            OverviewDir = "D:\\work\\overview with spaces",
            ScheduleHours = 6,
            Language = "he",
            StartWithWindows = false,
        };
        SettingsStore.Save(path, settings);
        var root = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        Assert.Equal(1, root["someday"]!["x"]!.GetValue<int>());
        Assert.Equal("https://adiutor.example.com", root["adiutorUrl"]!.GetValue<string>());
        Assert.Equal("http://127.0.0.1:3773", root["t3Url"]!.GetValue<string>());
        Assert.Equal("D:\\work\\overview with spaces", root["overviewDir"]!.GetValue<string>());
        Assert.False(root.ContainsKey("t3CliPath"));
        var back = SettingsStore.Load(path).Settings;
        Assert.Equal(6, back.ScheduleHours);
        Assert.Equal("he", back.Language);
        Assert.False(back.StartWithWindows);
    }

    [Theory]
    [InlineData("""{"scheduleHours":5}""", 3)]
    [InlineData("""{"scheduleHours":"3"}""", 3)]
    [InlineData("""{"scheduleHours":24}""", 24)]
    public void Schedule_takes_only_its_choices(string json, int hours)
    {
        using var dir = new TempFolder();
        File.WriteAllText(dir.File("settings.json"), json);
        Assert.Equal(hours, SettingsStore.Load(dir.File("settings.json")).Settings.ScheduleHours);
    }

    [Fact]
    public void Folder_names_with_spaces_and_hebrew_survive()
    {
        using var dir = new TempFolder();
        // A Hebrew folder name, written with escapes: Hebrew text lives only in the locale file.
        var folder = Path.Combine(dir.Root, "a b \u05EA\u05D9\u05E7\u05D9\u05D4");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "settings.json");
        SettingsStore.Save(path, new TraySettings { OverviewDir = Path.Combine(folder, "overview") });
        Assert.Equal(Path.Combine(folder, "overview"), SettingsStore.Load(path).Settings.OverviewDir);
    }

    [Fact]
    public void Data_folder_follows_the_engine()
    {
        Assert.Equal(Path.GetFullPath(@"D:\p\AppData\Local\adiutor"), DataFolder.Resolve(n => n == "USERPROFILE" ? @"D:\p" : null));
        Assert.Equal(Path.GetFullPath(@"E:\l\adiutor"), DataFolder.Resolve(n => n == "LOCALAPPDATA" ? @"E:\l" : n == "USERPROFILE" ? @"D:\p" : null));
    }
}
