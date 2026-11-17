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
    private DateTimeOffset _nextCheckinAt = DateTimeOffset.MinValue;
    private DateTimeOffset _retryAt = DateTimeOffset.MinValue;
    private bool _lastStartBusy;
    private bool _serverOlder;
    private string? _checkinProblem;
    private int _scheduledNotGood;
    private int _holdRuns;
    private bool _holdAll;
    private bool _updateReady;
    private readonly HashSet<string> _expectingDisconnect = [];
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

    /** No engine process of this tray runs and the loop starts none (for an update to be applied). */
    public bool IsIdle
    {
        get
        {
            lock (_gate)
                return _run is null && (_engine?.Active ?? 0) == 0;
        }
    }

    public bool IsRunning
    {
        get
        {
            lock (_gate)
                return _run is not null;
        }
    }

    // --- Called from the windows ---

    public void SyncNow()
    {
        lock (_gate)
            _manualRequested = true;
        Wake();
    }

    /** Pauses for a time, or until resumed (null), written to settings.json in the engine's format. */
    public void PauseFor(TimeSpan? duration)
    {
        lock (_gate)
        {
            var now = _time.GetUtcNow();
            _settings = _settings with { Pause = new Pause(duration is { } d ? now + d : null) };
            SettingsStore.Save(_settingsPath, _settings);
            _nextCheckinAt = now;
            _log.Info(duration is { } d2 ? $"paused for {d2.TotalHours:0.#} h" : "paused until resumed");
        }
        Wake();
    }

    public void Resume()
    {
        lock (_gate)
        {
            _settings = _settings with { Pause = null };
            SettingsStore.Save(_settingsPath, _settings);
            _nextCheckinAt = _time.GetUtcNow();
            _log.Info("resumed");
        }
        Wake();
    }

    /** Saves the settings the settings window changed; the pause is the loop's own and is kept. */
    public void SaveSettings(TraySettings settings)
    {
        lock (_gate)
        {
            _settings = settings with { Pause = _settings.Pause };
            SettingsStore.Save(_settingsPath, _settings);
            _statusDue = true;
        }
        Wake();
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
            if (_holdAll)
                return EngineOutcome.Failed("updating");
            if (name == "disconnect")
                _expectingDisconnect.Add("adiutor");
            if (name == "t3-disconnect")
                _expectingDisconnect.Add("t3");
        }
        var limit = name is "connect" or "t3-connect" ? ConnectLimit : CommandLimit;
        var outcome = await _engine.RunAsync(new EngineCommand(args, limit, OnEvent: onEvent), cancellationToken).ConfigureAwait(false);
        await RefreshStatusAsync(cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            _expectingDisconnect.Clear();
            _nextCheckinAt = _time.GetUtcNow();
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
        {
            await RecoverAsync(cancellationToken).ConfigureAwait(false);
            _recovered = true;
        }
        bool quitNow, checkinDue, statusDue, holdAll;
        var now = _time.GetUtcNow();
        lock (_gate)
        {
            quitNow = _quitRequested && _run is null;
            holdAll = _holdAll;
            checkinDue = !holdAll && now >= _nextCheckinAt;
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
                _nextCheckinAt = now + CheckinEvery;
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

    private async Task RecoverAsync(CancellationToken cancellationToken)
    {
        await RefreshStatusAsync(cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            // A run that served a request ended while the tray was gone: its report is the engine's last run.
            if (_state.RunningRequestId is { } id)
            {
                var last = _status?.LastRun;
                if (last?.RequestId == id && _state.Finished.All(f => f.RequestId != id))
                    _state = _state with { Finished = [.. _state.Finished, new FinishedRequest(id, last.T3.Result, last.Security.Result)] };
                _state = _state with { RunningRequestId = null };
                SaveState();
                _log.Info(last?.RequestId == id ? "recovered a finished request" : "a request run did not finish; Adiutor hands it again");
            }
        }
    }

    private async Task RefreshStatusAsync(CancellationToken cancellationToken)
    {
        if (_engine is null)
            return;
        var outcome = await _engine.RunAsync(new EngineCommand(["status"], CommandLimit), cancellationToken).ConfigureAwait(false);
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
        var outcome = await _engine.RunAsync(new EngineCommand(["checkin"], CommandLimit, report), cancellationToken).ConfigureAwait(false);
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
                var claim = result.Claim?.RequestId;
                _pendingClaim = claim is null || claim == _run?.RequestId || _state.Finished.Any(f => f.RequestId == claim) ? null : claim;
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
                    ["security"] = EngineOutput.PartName(f.Security),
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

    /** The run that should start now, if any: Sync now, then a claim, then the schedule. The caller executes it. */
    private RunningRun? TryStartRun(DateTimeOffset now)
    {
        if (_engine is null || _run is not null || _quitRequested || _holdAll || _holdRuns > 0)
            return null;
        var paused = _settings.IsPaused(now);
        if (_manualRequested)
        {
            _manualRequested = false;
            return StartRun(RunKind.Manual, null, now);
        }
        if (now < _retryAt || _status?.RunningSince is not null)
            return null;
        // A claim, also one recovered after a restart, never starts a run while paused (docs/sync.md, "While paused").
        if (_pendingClaim is { } claim && !paused)
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
        var notify = false;
        lock (_gate)
        {
            var now = _time.GetUtcNow();
            var result = outcome.Result;
            if (result is { Busy: true })
            {
                // Another run holds the lock: nothing ran. A request waits and is handed again by Adiutor.
                _lastStartBusy = true;
                _retryAt = now + RetryAfterBusy;
                _log.Info("run not started: another run is going");
            }
            else
            {
                var report = result?.Report;
                if (run.RequestId is { } requestId && result?.Error?.Code != "request_not_claimed")
                {
                    var t3 = report?.T3.Result ?? PartResult.Failed;
                    var security = report?.Security.Result ?? PartResult.Failed;
                    _state = _state with { Finished = [.. _state.Finished.Where(f => f.RequestId != requestId), new FinishedRequest(requestId, t3, security)] };
                    // Report it now rather than at the next minute.
                    _nextCheckinAt = now;
                }
                if (run.Kind == RunKind.Scheduled)
                {
                    _scheduledNotGood = report?.IsGood == true ? 0 : _scheduledNotGood + 1;
                    notify = _scheduledNotGood == 2;
                }
                _log.Info($"run finished: t3={Name(report?.T3.Result)} security={Name(report?.Security.Result)}");
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

    private TimeSpan NextWake(DateTimeOffset now)
    {
        var next = _nextCheckinAt;
        if (_settings.Pause?.Until is { } until && until > now && until < next)
            next = until;
        if (_retryAt > now && _retryAt < next)
            next = _retryAt;
        var due = DueAt(now);
        if (due > now && due < next)
            next = due;
        var wait = next - now;
        return wait < TimeSpan.Zero ? TimeSpan.Zero : wait;
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
