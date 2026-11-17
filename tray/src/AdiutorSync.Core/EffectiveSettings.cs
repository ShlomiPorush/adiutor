namespace AdiutorSync.Core;

/** Where the engine took a setting from (status's settings.values; docs/sync.md, "Settings"). */
public enum SettingSource
{
    Default,
    Option,
    Environment,
    EnvFile,
    SettingsFile,
}

/** A setting as the engine uses it, and where it came from. */
public sealed record EffectiveSetting(string? Value, SettingSource Source);

/** How the settings window offers a setting. */
public enum FieldMode
{
    /** The tray's settings file decides: editable. */
    Editable,

    /** Adiutor's address from sync.env, which Connect writes: editable, and a new address counts once connected. */
    EditableUntilConnect,

    /** Set by the environment: shown locked, with a note that the environment sets it (the owner's rule). */
    LockedByEnvironment,

    /** Set by an env file other than through Connect: shown locked, with a note. */
    LockedByEnvFile,
}

public static class EffectiveSettings
{
    public const string AdiutorUrl = "adiutorUrl";
    public const string T3CliPath = "t3CliPath";
    public const string T3Url = "t3Url";
    public const string OverviewDir = "overviewDir";

    /** The environment variable the engine reads for a setting, for the note on a locked field. */
    public static string EnvironmentName(string key) => key switch
    {
        AdiutorUrl => "ADIUTOR_URL",
        T3CliPath => "T3CODE_CLI_PATH",
        T3Url => "ADIUTOR_T3_URL",
        _ => "ADIUTOR_OVERVIEW_DIR",
    };

    /**
     * The text a settings field shows when a value arrives: the value the engine uses, unless the owner is editing an
     * editable field (its text differs from what it last showed). A locked field always shows the binding value: a
     * draft typed before the lock arrived is dropped, so what is shown is what commands use.
     */
    public static string FieldText(string current, string? lastShown, string value, bool locked) =>
        locked || lastShown is null || current == lastShown ? value : current;

    public static FieldMode Mode(string key, SettingSource? source) => source switch
    {
        SettingSource.Environment or SettingSource.Option => FieldMode.LockedByEnvironment,
        SettingSource.EnvFile when key == AdiutorUrl => FieldMode.EditableUntilConnect,
        SettingSource.EnvFile => FieldMode.LockedByEnvFile,
        _ => FieldMode.Editable,
    };
}
