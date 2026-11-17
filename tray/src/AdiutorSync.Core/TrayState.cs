using System.Text.Json;
using System.Text.Json.Serialization;

namespace AdiutorSync.Core;

/// <summary>A request from Adiutor whose run ended, kept until a check-in that listed it is answered.</summary>
public sealed record FinishedRequest(string RequestId, PartResult T3, PartResult Security);

/// <summary>
/// The tray's state file, tray-state.json in the data folder (no secret): the request a run is serving, written before
/// the run starts (the plan, "The tray writes a claim it receives to its state file before it starts the run"), the
/// finished requests not yet reported, and when the tray last started a run.
/// </summary>
public sealed record TrayState
{
    public const string FileName = "tray-state.json";

    public string? RunningRequestId { get; init; }
    public IReadOnlyList<FinishedRequest> Finished { get; init; } = [];
    public DateTimeOffset? LastAttemptAt { get; init; }
}

public static class StateStore
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) },
    };

    /** The state, or a fresh one when the file is missing or damaged (the engine still keeps the claim). */
    public static TrayState Load(string path)
    {
        var text = JsonFile.Read(path);
        if (text is null)
            return new TrayState();
        try
        {
            return JsonSerializer.Deserialize<TrayState>(text, Options) ?? new TrayState();
        }
        catch (JsonException)
        {
            return new TrayState();
        }
    }

    public static void Save(string path, TrayState state) =>
        JsonFile.WriteAtomic(path, JsonSerializer.Serialize(state, Options) + "\n");
}
