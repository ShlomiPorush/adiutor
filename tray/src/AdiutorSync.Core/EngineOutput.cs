using System.Text.Json;
using System.Text.Json.Serialization;

namespace AdiutorSync.Core;

// The engine's machine-readable output (docs/sync.md, "Machine-readable output"; src/sync/contract.ts): one JSON
// object per line on stdout, events first, then exactly one result. Only the fields the tray uses are read; any other
// field is ignored, so a newer engine that adds fields still parses. A line that is not one of these objects is
// skipped, and the result decides the outcome, never the exit code.

/** What one part of a run (T3 or security) came to. */
public enum PartResult
{
    Unknown,
    Accepted,
    Partial,
    Failed,
    OutcomeUnknown,
    NotRun,
}

public enum ConnectionState
{
    Unknown,
    Connected,
    NotConnected,
    Ended,
}

public sealed record EngineFailure(string Code, string Message);

public sealed record AdiutorConnection(ConnectionState State, string? Url, bool RevocationPending);

public sealed record T3Connection(ConnectionState State, string? Reason, DateTimeOffset? ExpiresAt, bool RevocationPending);

public sealed record RunPart(PartResult Result, string? Reason);

public sealed record RunReport(
    DateTimeOffset StartedAt,
    DateTimeOffset FinishedAt,
    bool DryRun,
    string? RequestId,
    RunPart T3,
    RunPart Security,
    DateTimeOffset? LastGoodSyncAt)
{
    /** Both parts accepted in this run: a good sync (docs/sync.md, "The result of each part"). */
    public bool IsGood => T3.Result == PartResult.Accepted && Security.Result == PartResult.Accepted;
}

public sealed record Claim(string RequestId, DateTimeOffset ReceivedAt);

public sealed record EngineStatus(
    AdiutorConnection Adiutor,
    T3Connection T3,
    RunReport? LastRun,
    DateTimeOffset? LastGoodSyncAt,
    DateTimeOffset? RunningSince,
    Claim? Claim,
    IReadOnlyList<string> SettingsProblems,
    IReadOnlyDictionary<string, EffectiveSetting>? Settings = null);

/** The one result line of a command, with the fields of every command; each command fills its own. */
public sealed record EngineResult(
    string? Command,
    bool Ok,
    EngineFailure? Error,
    EngineStatus? Status = null,
    RunReport? Report = null,
    bool Busy = false,
    DateTimeOffset? BusySince = null,
    Claim? Claim = null,
    string? ConnectState = null,
    bool? WasConnected = null,
    bool? RevocationPending = null);

public abstract record EngineEvent;

public sealed record MessageEvent(string Text) : EngineEvent;

/** `hold-run` holds the engine's run lock now, until its input ends. */
public sealed record HeldEvent : EngineEvent;

/** `connect`'s approval: the link with the code in it, and the code. */
public sealed record ApprovalEvent(string Link, string UserCode) : EngineEvent;

public static class EngineOutput
{
    public const int ContractVersion = 1;

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
    };

    /** Parses one line: an event, a result, or null for anything else. */
    public static object? ParseLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line) || line.TrimStart()[0] != '{')
            return null;
        Line? data;
        try
        {
            data = JsonSerializer.Deserialize<Line>(line, Options);
        }
        catch (JsonException)
        {
            return null;
        }
        if (data is null)
            return null;
        if (data.Type == "event")
        {
            return data.Event switch
            {
                "message" when data.Text is not null => new MessageEvent(data.Text),
                "approval" when data.Link is not null && data.UserCode is not null => new ApprovalEvent(data.Link, data.UserCode),
                "held" => new HeldEvent(),
                _ => null,
            };
        }
        if (data.Type != "result" || data.V != ContractVersion || data.Ok is null)
            return null;
        return ToResult(data);
    }

    public static PartResult Part(string? value) => value switch
    {
        "accepted" => PartResult.Accepted,
        "partial" => PartResult.Partial,
        "failed" => PartResult.Failed,
        "outcome_unknown" => PartResult.OutcomeUnknown,
        "not_run" => PartResult.NotRun,
        _ => PartResult.Unknown,
    };

    /** The engine's spelling of a part's result, for the check-in's `finished`. */
    public static string PartName(PartResult value) => value switch
    {
        PartResult.Accepted => "accepted",
        PartResult.Partial => "partial",
        PartResult.OutcomeUnknown => "outcome_unknown",
        PartResult.NotRun => "not_run",
        _ => "failed",
    };

    private static ConnectionState State(string? value) => value switch
    {
        "connected" => ConnectionState.Connected,
        "not_connected" => ConnectionState.NotConnected,
        "ended" => ConnectionState.Ended,
        _ => ConnectionState.Unknown,
    };

    private static EngineResult ToResult(Line data)
    {
        var error = data.Error is { Code: not null } e ? new EngineFailure(e.Code, e.Message ?? "") : null;
        EngineStatus? status = null;
        if (data.Command == "status" && data.Adiutor is not null && data.T3 is not null)
        {
            status = new EngineStatus(
                new AdiutorConnection(State(data.Adiutor.State), data.Adiutor.Url, data.Adiutor.RevocationPending ?? false),
                new T3Connection(State(data.T3.State), data.T3.Reason, data.T3.ExpiresAt, data.T3.RevocationPending ?? false),
                ToReport(data.LastRun),
                data.LastGoodSyncAt,
                data.Running?.StartedAt,
                ToClaim(data.Claim),
                data.Settings?.Problems ?? [],
                ToSettings(data.Settings?.Values));
        }
        return new EngineResult(
            data.Command,
            data.Ok == true,
            error,
            status,
            ToReport(data.Report),
            data.Busy is not null,
            data.Busy?.StartedAt,
            data.Command == "checkin" ? ToClaim(data.Claim) : null,
            data.State,
            data.WasConnected,
            data.RevocationPending);
    }

    private static Dictionary<string, EffectiveSetting>? ToSettings(Dictionary<string, EffectiveLine>? values) =>
        values?.Where(v => v.Value is not null).ToDictionary(v => v.Key, v => new EffectiveSetting(v.Value.Value, v.Value.Source switch
        {
            "option" => SettingSource.Option,
            "environment" => SettingSource.Environment,
            "envFile" => SettingSource.EnvFile,
            "settingsFile" => SettingSource.SettingsFile,
            _ => SettingSource.Default,
        }), StringComparer.Ordinal);

    private static Claim? ToClaim(ClaimLine? claim) =>
        claim is { RequestId: { Length: > 0 } id, ReceivedAt: { } at } ? new Claim(id.ToLowerInvariant(), at) : null;

    private static RunReport? ToReport(ReportLine? r)
    {
        if (r?.StartedAt is not { } started || r.FinishedAt is not { } finished)
            return null;
        return new RunReport(
            started,
            finished,
            r.DryRun ?? false,
            r.RequestId,
            new RunPart(Part(r.T3?.Result), r.T3?.Reason),
            new RunPart(Part(r.Security?.Result), r.Security?.Reason),
            r.LastGoodSyncAt);
    }

    // The wire shapes, as contract.ts writes them.
    private sealed class Line
    {
        public string? Type { get; set; }
        public int? V { get; set; }
        public string? Event { get; set; }
        public string? Text { get; set; }
        public string? Link { get; set; }
        public string? UserCode { get; set; }
        public string? Command { get; set; }
        public bool? Ok { get; set; }
        public FailureLine? Error { get; set; }
        public AdiutorLine? Adiutor { get; set; }
        public T3Line? T3 { get; set; }
        public ReportLine? LastRun { get; set; }
        public DateTimeOffset? LastGoodSyncAt { get; set; }
        public RunningLine? Running { get; set; }
        public ClaimLine? Claim { get; set; }
        public SettingsLine? Settings { get; set; }
        public string? State { get; set; }
        public bool? WasConnected { get; set; }
        public bool? RevocationPending { get; set; }
        public RunningLine? Busy { get; set; }
        public ReportLine? Report { get; set; }
    }

    private sealed class FailureLine
    {
        public string? Code { get; set; }
        public string? Message { get; set; }
    }

    private sealed class AdiutorLine
    {
        public string? State { get; set; }
        public string? Url { get; set; }
        public bool? RevocationPending { get; set; }
    }

    private sealed class T3Line
    {
        public string? State { get; set; }
        public string? Reason { get; set; }
        public DateTimeOffset? ExpiresAt { get; set; }
        public bool? RevocationPending { get; set; }
    }

    private sealed class RunningLine
    {
        public DateTimeOffset? StartedAt { get; set; }
    }

    private sealed class ClaimLine
    {
        public string? RequestId { get; set; }
        public DateTimeOffset? ReceivedAt { get; set; }
    }

    private sealed class SettingsLine
    {
        public List<string>? Problems { get; set; }
        public Dictionary<string, EffectiveLine>? Values { get; set; }
    }

    private sealed class EffectiveLine
    {
        public string? Value { get; set; }
        public string? Source { get; set; }
    }

    private sealed class PartLine
    {
        public string? Result { get; set; }
        public string? Reason { get; set; }
    }

    private sealed class ReportLine
    {
        public DateTimeOffset? StartedAt { get; set; }
        public DateTimeOffset? FinishedAt { get; set; }
        public bool? DryRun { get; set; }
        public string? RequestId { get; set; }
        public PartLine? T3 { get; set; }
        public PartLine? Security { get; set; }
        public DateTimeOffset? LastGoodSyncAt { get; set; }
    }

}
