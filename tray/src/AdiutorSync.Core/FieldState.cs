namespace AdiutorSync.Core;

/**
 * What one settings field shows as values arrive (each status read, check-in and loop turn). Its baseline is the value
 * it last took from the engine, or what a save wrote. A text that differs from the baseline is the owner's draft, and
 * stays through any number of refreshes until a save, also after a save that failed. A locked field always shows the
 * value the engine uses, so a draft typed before the lock arrived is dropped.
 */
public sealed class FieldState
{
    private string? _baseline;

    /** The text to show when a value arrives, given what the field shows now. */
    public string Refresh(string current, string value, bool locked)
    {
        if (!locked && _baseline is not null && current != _baseline)
            return current;
        _baseline = value;
        return value;
    }

    /** A save wrote what the field shows: it is the baseline now, no longer a draft. */
    public void Saved(string current) => _baseline = current;
}
