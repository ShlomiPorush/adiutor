using System.Text.Json;
using System.Text.Json.Nodes;

namespace AdiutorSync.Core;

public enum RunKind
{
    Scheduled,
    Manual,
    Request,
}

public sealed record RunningRun(RunKind Kind, string? RequestId, DateTimeOffset StartedAt);

/// <summary>Why the tray shows a Windows notification (the plan: only these two).</summary>
public enum Notice
{
    ScheduledRunsNotGood,
    AdiutorConnectionEnded,
    T3ConnectionEnded,
}

/// <summary>What the icon, the panel and the settings window show, as one immutable view.</summary>
public sealed record TraySnapshot
{
    public EngineStatus? Status { get; init; }
    public bool EngineMissing { get; init; }

    /** The engine's status could not be read the last time it was asked (its failure code). */
    public string? StatusProblem { get; init; }
    public RunningRun? Running { get; init; }

    /** A run that is not the tray's holds the engine's run lock (one started from the command line). */
    public DateTimeOffset? RunningElsewhereSince { get; init; }
    public required TraySettings Settings { get; init; }
    public bool Paused { get; init; }
    public DateTimeOffset? NextRunAt { get; init; }

    /** The last run the tray started was not started: another run held the lock. */
    public bool LastStartBusy { get; init; }

    /** Adiutor has no check-in (an older server): requests from Adiutor are not available. */
    public bool ServerOlder { get; init; }

    /** The last check-in failed with this code; null when it was answered or none was made. */
    public string? CheckinProblem { get; init; }
    public bool Quitting { get; init; }
    public bool UpdateReady { get; init; }

    /** The last change to the settings file could not be written, so it did not happen. */
    public bool SettingsNotSaved { get; init; }
}

/// <summary>
/// The tray's loop (the plan, section 4, "Tray" and "Adiutor server and UI (sync requests)"): a check-in every minute,
/// also while a run is going; a claim from Adiutor runs `run --request id`, never while paused; the schedule; Sync now;
/// the pause; one run at a time; Quit after the run ends. <see cref="TickAsync"/> does one round and says how long to
/// wait; <see cref="RunAsync"/> repeats it. Everything else is called from the windows and only sets state and wakes
/// the loop.
/// </summary>
public sealed class SyncLoop
{
    public static readonly TimeSpan CheckinEvery = TimeSpan.FromMinutes(1);
    public static readonly TimeSpan RetryAfterBusy = TimeSpan.FromMinutes(1);
    public static readonly TimeSpan RunLimit = TimeSpan.FromMinutes(60);
    public static readonly TimeSpan CommandLimit = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan ConnectLimit = TimeSpan.FromMinutes(20);
    public const int MaxFinishedPerReport = 20;

    private readonly IEngine? _engine;
    private readonly TimeProvider _time;
    private readonly ITrayLog _log;
    private readonly string _settingsPath;
    private readonly string _statePath;
    private readonly string _version;
    private readonly object _gate = new();

    private TraySettings _settings;
    private TrayState _state;
    private EngineStatus? _status;
    private string? _statusProblem;
    private RunningRun? _run;
    private Task _runTask = Task.CompletedTask;
    private string? _pendingClaim;
    private bool _manualRequested;
    private bool _quitRequested;
    private bool _statusDue = true;
    private bool _recovered;
    // Cadence on the monotonic clock (TimeProvider timestamps), so a wall clock set back never stops the check-ins.
    private long _nextCheckinAt = long.MinValue;
    private long _retryAt = long.MinValue;
    private int _commands;
    private bool _runLockHeld;
    private bool _closed;
    private bool _lastStartBusy;
    private bool _serverOlder;
    private string? _checkinProblem;
    private int _scheduledNotGood;
    private int _holdRuns;
    private bool _holdAll;
    private bool _updateReady;
    private bool _settingsNotSaved;
    private readonly HashSet<string> _expectingDisconnect = [];

    /** Requests whose run ended in this tray (reported, refused by the engine, or without a result): never run again. */
    private readonly HashSet<string> _ended = new(StringComparer.OrdinalIgnoreCase);
    private TaskCompletionSource _wake = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public SyncLoop(IEngine? engine, string dataFolder, TimeProvider time, string version, ITrayLog log)
    {
        _engine = engine;
        _time = time;
        _log = log;
        _version = version;
        _settingsPath = Path.Combine(dataFolder, TraySettings.FileName);
        _statePath = Path.Combine(dataFolder, TrayState.FileName);
        _settings = SettingsStore.Load(_settingsPath).Settings;
        _state = StateStore.Load(_statePath);
    }

    /** Raised after any change the windows show; may come from any thread. */
    public event Action<TraySnapshot>? Changed;

    public event Action<Notice>? Notify;

    public TraySnapshot Snapshot
    {
        get
        {
            lock (_gate)
                return BuildSnapshot(_time.GetUtcNow());
        }
    }

    /**
     * Nothing runs: no run and no other engine command of this tray, and no run started from the command line (the
     * engine's last status), so an update may be checked, downloaded or installed.
     */
    public bool IsIdle
    {
        get
        {
            lock (_gate)
                return IdleCore();
        }
    }

    private bool IdleCore() => _run is null && _commands == 0 && (_runLockHeld || _status?.RunningSince is null);

    // --- Called from the windows ---

    public void SyncNow()
    {
        lock (_gate)
            _manualRequested = true;
        Wake();
    }

    /**
     * Pauses for a time, or until resumed (null), written to settings.json in the engine's format. False, with nothing
     * changed, when the file cannot be written.
     */
    public bool PauseFor(TimeSpan? duration)
    {
        lock (_gate)
        {
            var now = _time.GetUtcNow();
            if (!TryWriteSettings(_settings with { Pause = new Pause(duration is { } d ? now + d : null) }))
                return false;
            _nextCheckinAt = Timestamp();
            _log.Info(duration is { } d2 ? $"paused for {d2.TotalHours:0.#} h" : "paused until resumed");
        }
        Wake();
        return true;
    }

    public bool Resume()
    {
        lock (_gate)
        {
            if (!TryWriteSettings(_settings with { Pause = null }))
                return false;
            _nextCheckinAt = Timestamp();
            _log.Info("resumed");
        }
        Wake();
        return true;
    }

    /** Saves the settings the settings window changed; the pause is the loop's own and is kept. False when not written. */
    public bool SaveSettings(TraySettings settings)
    {
        lock (_gate)
        {
            if (!TryWriteSettings(settings with { Pause = _settings.Pause }))
                return false;
            _statusDue = true;
        }
        Wake();
        return true;
    }

    /**
     * Writes the settings file, and only then takes the new settings: a write that fails (a full disk, no permission,
     * a file another program holds) changes nothing, and the windows say so. Called under the lock.
     */
    private bool TryWriteSettings(TraySettings next)
    {
        try
        {
            SettingsStore.Save(_settingsPath, next);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _settingsNotSaved = true;
            _log.Info($"settings file not written ({e.GetType().Name})");
            Publish();
            return false;
        }
        _settings = next;
        _settingsNotSaved = false;
        return true;
    }

    /** Quit: no new run; a run going finishes first ("finishing the run"), then the loop ends. */
    public void RequestQuit()
    {
        lock (_gate)
            _quitRequested = true;
        Wake();
    }

    /** While held, no run starts (an update is being checked or downloaded). */
    public IDisposable HoldRuns()
    {
        lock (_gate)
            _holdRuns++;
        return new Release(() =>
        {
            lock (_gate)
                _holdRuns--;
            Wake();
        });
    }

    /** No run and no other engine command starts until released (an update is being applied). */
    public IDisposable HoldAll()
    {
        lock (_gate)
            _holdAll = true;
        return new Release(() =>
        {
            lock (_gate)
                _holdAll = false;
            Wake();
        });
    }

    /** Holds every engine command of the tray for an install; null, with nothing held, when one runs. */
    public IDisposable? HoldForInstall()
    {
        var hold = HoldAll();
        bool idle;
        lock (_gate)
            idle = _run is null && _commands == 0;
        if (idle)
            return hold;
        hold.Dispose();
        return null;
    }

    /**
     * Takes the engine's own run lock (`hold-run`) and keeps it until the lease is disposed, so no run starts, from the
     * tray or the command line, while an update is checked, downloaded or installed. Null when a run holds it (or the
     * engine cannot). The holding engine is in the tray's job: if the tray ends, it ends, and its lock is taken over.
     */
    public async Task<RunLockLease?> HoldRunLockAsync(CancellationToken cancellationToken)
    {
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var command = new EngineCommand(["hold-run"], HoldRunLimit, OnEvent: e =>
        {
            if (e is HeldEvent)
                held.TrySetResult();
        }, InputOpenUntil: release.Task);
        var holding = RunEngineAsync(command, cancellationToken, duringInstallHold: true, counts: false);
        if (await Task.WhenAny(held.Task, holding).ConfigureAwait(false) != held.Task)
            return null;
        lock (_gate)
            _runLockHeld = true;
        // However it ends (released, or hold-run ended early), the tray no longer holds the lock.
        _ = holding.ContinueWith(_ =>
        {
            lock (_gate)
                _runLockHeld = false;
            Wake();
        }, TaskScheduler.Default);
        return new RunLockLease(holding, release);
    }

    /** Longer than an update's check, download and install may take; the lock is released before. */
    public static readonly TimeSpan HoldRunLimit = TimeSpan.FromMinutes(15);

    /**
     * Ends the tray's use of the engine before its job closes: no command starts any more, and this waits (up to the
     * limit) for those under way to end.
     */
    public async Task CloseAsync(TimeSpan limit)
    {
        lock (_gate)
            _closed = true;
        var until = DateTime.UtcNow + limit;
        while (DateTime.UtcNow < until)
        {
            lock (_gate)
            {
                if (_commands == 0 && _run is null)
                    return;
            }
            await Task.Delay(50).ConfigureAwait(false);
        }
    }

    public void SetUpdateReady(bool ready)
    {
        lock (_gate)
            _updateReady = ready;
        Publish();
    }

    /**
     * Runs an engine command of the settings window (connect, disconnect, t3-connect, t3-disconnect), then reads the
     * status again. A disconnect the owner asked for is not a connection that ended.
     */
    public async Task<EngineOutcome> RunCommandAsync(IReadOnlyList<string> args, Action<EngineEvent>? onEvent, CancellationToken cancellationToken)
    {
        if (_engine is null)
            return EngineOutcome.Failed("engine_missing");
        var name = args[0];
        lock (_gate)
        {
            if (name == "disconnect")
                _expectingDisconnect.Add("adiutor");
            if (name == "t3-disconnect")
                _expectingDisconnect.Add("t3");
        }
        var limit = name is "connect" or "t3-connect" ? ConnectLimit : CommandLimit;
        var outcome = await RunEngineAsync(new EngineCommand(args, limit, OnEvent: onEvent), cancellationToken).ConfigureAwait(false);
        await RefreshStatusAsync(cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            _expectingDisconnect.Clear();
            _nextCheckinAt = Timestamp();
        }
        Wake();
        return outcome;
    }

    // --- The loop ---

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var (done, wait) = await TickAsync(cancellationToken).ConfigureAwait(false);
            if (done)
                return;
            Task wake;
            lock (_gate)
                wake = _wake.Task;
            using var delay = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            await Task.WhenAny(Task.Delay(wait, _time, delay.Token), wake).ConfigureAwait(false);
            await delay.CancelAsync().ConfigureAwait(false);
            lock (_gate)
            {
                if (_wake.Task.IsCompleted)
                    _wake = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            }
        }
    }

    /** One round: recovery once, the status and the check-in when due, then a run when one should start. */
    public async Task<(bool Done, TimeSpan Wait)> TickAsync(CancellationToken cancellationToken)
    {
        if (!_recovered)
            _recovered = await RecoverAsync(cancellationToken).ConfigureAwait(false);
        bool quitNow, checkinDue, statusDue, holdAll;
        var now = _time.GetUtcNow();
        lock (_gate)
        {
            quitNow = _quitRequested && _run is null;
            holdAll = _holdAll;
            checkinDue = !holdAll && Timestamp() >= _nextCheckinAt;
            statusDue = !holdAll && (_statusDue || checkinDue);
        }
        if (quitNow)
        {
            // A run that finished while quitting is reported before the tray ends.
            bool report;
            lock (_gate)
                report = _state.Finished.Count > 0 && !holdAll;
            if (report)
            {
                await RefreshStatusAsync(cancellationToken).ConfigureAwait(false);
                await CheckInAsync(cancellationToken).ConfigureAwait(false);
            }
            _log.Info("quit");
            return (true, TimeSpan.Zero);
        }
        if (statusDue)
            await RefreshStatusAsync(cancellationToken).ConfigureAwait(false);
        if (checkinDue)
        {
            lock (_gate)
                _nextCheckinAt = TimestampAfter(CheckinEvery);
            await CheckInAsync(cancellationToken).ConfigureAwait(false);
        }
        RunningRun? started;
        lock (_gate)
            started = TryStartRun(_time.GetUtcNow());
        if (started is not null)
        {
            // Started outside the lock: the engine process starts here and the run goes on in the background.
            var task = ExecuteRunAsync(started);
            lock (_gate)
                _runTask = task;
        }
        lock (_gate)
        {
            now = _time.GetUtcNow();
            Publish();
            return (false, NextWake(now));
        }
    }

    /** Waits for the run going, if any (tests, and Quit). */
    public Task CurrentRun
    {
        get
        {
            lock (_gate)
                return _runTask;
        }
    }

    // --- Inside the loop ---

    /**
     * Finishes what a tray that stopped during a request's run left: true once decided. Without a status it can trust,
     * the request's id stays in the state file and the next round tries again; no run starts meanwhile.
     */
    private async Task<bool> RecoverAsync(CancellationToken cancellationToken)
    {
        await RefreshStatusAsync(cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            // A run that served a request ended while the tray was gone: its report is the engine's last run.
            if (_state.RunningRequestId is { } id)
            {
                if (_status is null || _statusProblem is not null)
                    return false;
                var last = _status.LastRun;
                if (last?.RequestId == id)
                {
                    // Its run ended: it is reported, never run again.
                    _ended.Add(id);
                    if (_state.Finished.All(f => f.RequestId != id))
                        _state = _state with { Finished = [.. _state.Finished, new FinishedRequest(id, last.T3.Result)] };
                }
                _state = _state with { RunningRequestId = null };
                SaveState();
                _log.Info(last?.RequestId == id ? "recovered a finished request" : "a request run did not finish; Adiutor hands it again");
            }
            return true;
        }
    }

    private async Task RefreshStatusAsync(CancellationToken cancellationToken)
    {
        if (_engine is null)
            return;
        var outcome = await RunEngineAsync(new EngineCommand(["status"], CommandLimit), cancellationToken).ConfigureAwait(false);
        if (outcome.Failure is Updating or Closed)
            return;
        var notices = new List<Notice>();
        lock (_gate)
        {
            _statusDue = false;
            if (outcome.Result is { Ok: true, Status: { } status })
            {
                var before = _status;
                if (before is not null)
                {
                    if (Ended(before.Adiutor.State, status.Adiutor.State) && !_expectingDisconnect.Contains("adiutor"))
                        notices.Add(Notice.AdiutorConnectionEnded);
                    if (Ended(before.T3.State, status.T3.State) && !_expectingDisconnect.Contains("t3"))
                        notices.Add(Notice.T3ConnectionEnded);
                }
                _status = status;
                _statusProblem = null;
            }
            else
            {
                _statusProblem = outcome.Result?.Error?.Code ?? outcome.Failure ?? "no_status";
            }
            Publish();
        }
        foreach (var notice in notices)
            Notify?.Invoke(notice);
    }

    private static bool Ended(ConnectionState before, ConnectionState after) =>
        before == ConnectionState.Connected && after is ConnectionState.Ended or ConnectionState.NotConnected;

    private async Task CheckInAsync(CancellationToken cancellationToken)
    {
        if (_engine is null)
            return;
        string report;
        List<string> sent;
        lock (_gate)
        {
            // The check-in needs the Adiutor connection; without it the engine would refuse anyway.
            if (_status?.Adiutor.State is not ConnectionState.Connected)
                return;
            var now = _time.GetUtcNow();
            var finished = _state.Finished.Take(MaxFinishedPerReport).ToList();
            sent = [.. finished.Select(f => f.RequestId)];
            report = BuildReport(now, finished);
        }
        var outcome = await RunEngineAsync(new EngineCommand(["checkin"], CommandLimit, report), cancellationToken).ConfigureAwait(false);
        if (outcome.Failure is Updating or Closed)
            return;
        lock (_gate)
        {
            if (outcome.Result is { Ok: true } result)
            {
                _serverOlder = false;
                _checkinProblem = null;
                if (sent.Count > 0)
                {
                    _state = _state with { Finished = [.. _state.Finished.Where(f => !sent.Contains(f.RequestId))] };
                    SaveState();
                }
                // An answer without a claim does not drop one the tray holds: Adiutor stops answering a claim whose lease
                // passed (while paused, or behind a long local run), but the engine keeps it, runs it, and Adiutor takes
                // its late result (docs/api.md, "Sync requests").
                if (result.Claim?.RequestId is { } claim && IsOpen(claim))
                    _pendingClaim = claim;
            }
            else
            {
                var code = outcome.Result?.Error?.Code ?? outcome.Failure ?? "no_result";
                _serverOlder = code == "server_older";
                _checkinProblem = _serverOlder ? null : code;
            }
            Publish();
        }
    }

    /** The check-in report (docs/sync.md, "Requests from Adiutor"); every field is always written. */
    internal string BuildReport(DateTimeOffset now, IReadOnlyList<FinishedRequest> finished)
    {
        var paused = _settings.IsPaused(now);
        JsonNode? running = null;
        if (_run is { Kind: RunKind.Request, RequestId: { } id })
            running = new JsonObject { ["kind"] = "request", ["requestId"] = id };
        else if (_run is { } local)
            running = new JsonObject { ["kind"] = "local", ["startedAt"] = Times.Iso(local.StartedAt) };
        else if (_status?.RunningSince is { } since)
            running = new JsonObject { ["kind"] = "local", ["startedAt"] = Times.Iso(since) };
        var next = NextRunAt(now);
        var root = new JsonObject
        {
            ["version"] = _version,
            ["paused"] = paused,
            ["pausedUntil"] = paused && _settings.Pause?.Until is { } until ? Times.Iso(until) : null,
            ["nextRunAt"] = next is { } n ? Times.Iso(n) : null,
            ["running"] = running,
            ["finished"] = new JsonArray([.. finished.Select(f => (JsonNode)new JsonObject
            {
                ["requestId"] = f.RequestId,
                ["result"] = new JsonObject
                {
                    ["t3"] = EngineOutput.PartName(f.T3),
                    // Adiutor's check-in takes both parts; the server reads GitHub itself, so the sync never runs this one.
                    ["security"] = EngineOutput.PartName(PartResult.NotRun),
                },
            })]),
        };
        return root.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
    }

    /** When the schedule wants the next run: the interval after the last run started, or now when there was none. */
    private DateTimeOffset DueAt(DateTimeOffset now)
    {
        var last = Max(_status?.LastRun?.StartedAt, _state.LastAttemptAt);
        return last is { } at ? at + _settings.Interval : now;
    }

    /** The next scheduled run as the report and the panel show it: none while paused until resumed. */
    private DateTimeOffset? NextRunAt(DateTimeOffset now)
    {
        var due = DueAt(now);
        if (_settings.IsPaused(now))
            return _settings.Pause!.Until is { } until ? Max(due, until) : null;
        return due < now ? now : due;
    }

    /** A request this tray has not run yet, and is not running. */
    private bool IsOpen(string requestId) =>
        !string.Equals(requestId, _run?.RequestId, StringComparison.OrdinalIgnoreCase) && !_ended.Contains(requestId) &&
        _state.Finished.All(f => !string.Equals(f.RequestId, requestId, StringComparison.OrdinalIgnoreCase));

    /** The claim to run: the last one Adiutor answered, or else the one the engine keeps (its status). */
    private string? OpenClaim()
    {
        if (_pendingClaim is { } answered && IsOpen(answered))
            return answered;
        return _status?.Claim?.RequestId is { } kept && IsOpen(kept) ? kept : null;
    }

    /** The run that should start now, if any: Sync now, then a claim, then the schedule. The caller executes it. */
    private RunningRun? TryStartRun(DateTimeOffset now)
    {
        if (_engine is null || _run is not null || _quitRequested || _closed || _holdAll || _holdRuns > 0 || !_recovered)
            return null;
        var paused = _settings.IsPaused(now);
        if (_manualRequested)
        {
            _manualRequested = false;
            return StartRun(RunKind.Manual, null, now);
        }
        if (Timestamp() < _retryAt || _status?.RunningSince is not null)
            return null;
        // A claim, also one recovered after a restart, never starts a run while paused (docs/sync.md, "While paused").
        if (OpenClaim() is { } claim && !paused)
        {
            _pendingClaim = null;
            return StartRun(RunKind.Request, claim, now);
        }
        if (!paused && _status?.Adiutor.State == ConnectionState.Connected && now >= DueAt(now))
            return StartRun(RunKind.Scheduled, null, now);
        return null;
    }

    private RunningRun StartRun(RunKind kind, string? requestId, DateTimeOffset now)
    {
        _run = new RunningRun(kind, requestId, now);
        _lastStartBusy = false;
        // The request is written to the state file before its run starts, so a tray that stops finds it again.
        _state = _state with { LastAttemptAt = now, RunningRequestId = requestId ?? _state.RunningRequestId };
        SaveState();
        _log.Info($"run started: {kind.ToString().ToLowerInvariant()}");
        return _run;
    }

    private async Task ExecuteRunAsync(RunningRun run)
    {
        List<string> args = ["run"];
        if (run.RequestId is { } id)
            args.AddRange(["--request", id]);
        EngineOutcome outcome;
        try
        {
            outcome = await _engine!.RunAsync(new EngineCommand(args, RunLimit), CancellationToken.None).ConfigureAwait(false);
        }
#pragma warning disable CA1031 // A run that throws ends like a run without a result; the loop goes on.
        catch (Exception)
#pragma warning restore CA1031
        {
            outcome = EngineOutcome.Failed("no_result");
        }
        // Without a report (the engine crashed, timed out or printed no result), the engine's last run may still be this
        // request's: its status says so. Otherwise the result is not known, and nothing is made up.
        RunReport? recovered = null;
        if (run.RequestId is { } served && outcome.Result is not { Busy: true } && outcome.Result?.Report is null &&
            outcome.Result?.Error?.Code != "request_not_claimed")
        {
            await RefreshStatusAsync(CancellationToken.None).ConfigureAwait(false);
            lock (_gate)
                recovered = _status?.LastRun is { } last && string.Equals(last.RequestId, served, StringComparison.OrdinalIgnoreCase) ? last : null;
        }
        var notify = false;
        lock (_gate)
        {
            var now = _time.GetUtcNow();
            var result = outcome.Result;
            if (result is { Busy: true })
            {
                // Another run holds the lock: nothing ran. A request waits and is handed again by Adiutor.
                _lastStartBusy = true;
                _retryAt = TimestampAfter(RetryAfterBusy);
                _log.Info("run not started: another run is going");
            }
            else
            {
                var report = result?.Report ?? recovered;
                if (run.RequestId is { } requestId)
                {
                    _ended.Add(requestId);
                    if (result?.Error?.Code == "request_not_claimed")
                    {
                        // The engine does not hold it: nothing ran, nothing is reported.
                    }
                    else if (report is not null)
                    {
                        _state = _state with { Finished = [.. _state.Finished.Where(f => f.RequestId != requestId), new FinishedRequest(requestId, report.T3.Result)] };
                        // Report it now rather than at the next minute.
                        _nextCheckinAt = Timestamp();
                    }
                    else
                    {
                        // Adiutor makes the request unknown when its lease passes, as for a computer that stopped.
                        _log.Info("a request run ended without a result; it is not reported");
                    }
                }
                if (run.Kind == RunKind.Scheduled)
                {
                    _scheduledNotGood = report?.IsGood == true ? 0 : _scheduledNotGood + 1;
                    notify = _scheduledNotGood == 2;
                }
                _log.Info($"run finished: t3={Name(report?.T3.Result)}");
            }
            if (run.RequestId is not null)
                _state = _state with { RunningRequestId = null };
            SaveState();
            _run = null;
            _statusDue = true;
            Publish();
        }
        if (notify)
            Notify?.Invoke(Notice.ScheduledRunsNotGood);
        Wake();
    }

    private static string Name(PartResult? part) => part is { } p ? EngineOutput.PartName(p) : "none";

    /** The shortest wait: the check-in and a retry on the monotonic clock, a pause's end and the schedule on the wall clock. */
    private TimeSpan NextWake(DateTimeOffset now)
    {
        var wait = _holdAll ? CheckinEvery : Until(_nextCheckinAt);
        if (_retryAt > Timestamp() && Until(_retryAt) < wait)
            wait = Until(_retryAt);
        if (_settings.Pause?.Until is { } until && until > now && until - now < wait)
            wait = until - now;
        var due = DueAt(now);
        if (due > now && due - now < wait)
            wait = due - now;
        return wait < TimeSpan.Zero ? TimeSpan.Zero : wait;
    }

    private long Timestamp() => _time.GetTimestamp();

    private long TimestampAfter(TimeSpan span) => _time.GetTimestamp() + (long)(span.TotalSeconds * _time.TimestampFrequency);

    private TimeSpan Until(long timestamp)
    {
        var now = _time.GetTimestamp();
        return timestamp <= now ? TimeSpan.Zero : TimeSpan.FromSeconds((timestamp - now) / (double)_time.TimestampFrequency);
    }

    private const string Updating = "updating";
    private const string Closed = "closed";

    /**
     * Every engine command but a run goes through here: whether an install holds everything and the registration of
     * the command are decided in one step under the lock, so an install never starts while a command is starting.
     * Only the install's own status read passes the hold.
     */
    private async Task<EngineOutcome> RunEngineAsync(EngineCommand command, CancellationToken cancellationToken, bool duringInstallHold = false, bool counts = true)
    {
        if (_engine is null)
            return EngineOutcome.Failed("engine_missing");
        lock (_gate)
        {
            if (_closed)
                return EngineOutcome.Failed(Closed);
            if (_holdAll && !duringInstallHold)
                return EngineOutcome.Failed(Updating);
            if (counts)
                _commands++;
        }
        try
        {
            return await _engine.RunAsync(command, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            if (counts)
            {
                lock (_gate)
                    _commands--;
            }
        }
    }

    private TraySnapshot BuildSnapshot(DateTimeOffset now) => new()
    {
        Status = _status,
        EngineMissing = _engine is null,
        StatusProblem = _statusProblem,
        Running = _run,
        RunningElsewhereSince = _run is null ? _status?.RunningSince : null,
        Settings = _settings,
        Paused = _settings.IsPaused(now),
        // No scheduled run starts without the Adiutor connection, so none is shown.
        NextRunAt = _status?.Adiutor.State == ConnectionState.Connected ? NextRunAt(now) : null,
        LastStartBusy = _lastStartBusy,
        ServerOlder = _serverOlder,
        CheckinProblem = _checkinProblem,
        Quitting = _quitRequested,
        UpdateReady = _updateReady,
        SettingsNotSaved = _settingsNotSaved,
    };

    private void Publish()
    {
        TraySnapshot snapshot;
        lock (_gate)
            snapshot = BuildSnapshot(_time.GetUtcNow());
        Changed?.Invoke(snapshot);
    }

    private void SaveState()
    {
        try
        {
            StateStore.Save(_statePath, _state);
        }
        catch (IOException)
        {
            _log.Info("state file not written");
        }
        catch (UnauthorizedAccessException)
        {
            _log.Info("state file not written");
        }
    }

    private void Wake()
    {
        lock (_gate)
            _wake.TrySetResult();
    }

    private static DateTimeOffset? Max(DateTimeOffset? a, DateTimeOffset? b) =>
        a is null ? b : b is null ? a : a > b ? a : b;

    private static DateTimeOffset Max(DateTimeOffset a, DateTimeOffset b) => a > b ? a : b;

    private sealed class Release(Action action) : IDisposable
    {
        private Action? _action = action;

        public void Dispose() => Interlocked.Exchange(ref _action, null)?.Invoke();
    }
}
