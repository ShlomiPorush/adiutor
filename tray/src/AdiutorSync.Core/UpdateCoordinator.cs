namespace AdiutorSync.Core;

/// <summary>Velopack's update manager as the coordinator uses it (the app wraps it; tests fake it).</summary>
public interface IAppUpdater
{
    /** Installed by Velopack's installer; a development build never updates. */
    bool IsInstalled { get; }

    /** The newer release, or null when there is none. */
    Task<object?> CheckAsync(CancellationToken cancellationToken);

    Task DownloadAsync(object update, CancellationToken cancellationToken);

    /**
     * Installs the downloaded release and starts the new version; the process ends. When the install cannot start, it
     * throws, and the app is as it was (its icon included).
     */
    void Apply(object update);
}

/// <summary>
/// When the tray looks for, downloads and installs an update (owner's decision D-T7: automatic updates from GitHub
/// Releases through Velopack, installed only when no run is going). The check and the download happen only when the
/// tray runs nothing, and hold the runs meanwhile, for at most <see cref="HoldLimit"/>: a claim from Adiutor that waits
/// keeps its lease (10 minutes, renewed only while its run is reported). The install waits until no engine process of
/// the tray runs, and stops every other engine command while it starts.
/// </summary>
public sealed class UpdateCoordinator(SyncLoop loop, IAppUpdater updater, TimeProvider time, ITrayLog log)
{
    public static readonly TimeSpan FirstCheckAfter = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan CheckEvery = TimeSpan.FromHours(6);
    public static readonly TimeSpan RetryWhenBusy = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan HoldLimit = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan ApplyEvery = TimeSpan.FromSeconds(30);

    private object? _ready;
    private bool _applyFailed;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!updater.IsInstalled)
        {
            log.Info("updates: off in a development build");
            return;
        }
        var wait = FirstCheckAfter;
        while (!cancellationToken.IsCancellationRequested)
        {
            await Task.Delay(wait, time, cancellationToken).ConfigureAwait(false);
            if (_ready is null)
            {
                wait = await CheckAndDownloadAsync(cancellationToken).ConfigureAwait(false);
                if (_ready is null)
                    continue;
            }
            if (await TryApplyAsync(cancellationToken).ConfigureAwait(false))
                return;
            wait = _applyFailed ? CheckEvery : ApplyEvery;
        }
    }

    /** Looks for an update and downloads it, when the tray runs nothing; returns when to look again. */
    internal async Task<TimeSpan> CheckAndDownloadAsync(CancellationToken cancellationToken)
    {
        if (!loop.IsIdle)
            return RetryWhenBusy;
        using var hold = loop.HoldRuns();
        if (!loop.IsIdle)
            return RetryWhenBusy;
        // The engine's run lock: no run from the command line starts while the update is checked and downloaded.
        await using var runLock = await loop.HoldRunLockAsync(cancellationToken).ConfigureAwait(false);
        if (runLock is null)
            return RetryWhenBusy;
        using var limit = new CancellationTokenSource(HoldLimit, time);
        using var both = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, limit.Token);
        try
        {
            var update = await updater.CheckAsync(both.Token).ConfigureAwait(false);
            if (update is null)
            {
                log.Info("updates: none");
                return CheckEvery;
            }
            await updater.DownloadAsync(update, both.Token).ConfigureAwait(false);
            _ready = update;
            loop.SetUpdateReady(true);
            log.Info("updates: downloaded");
            return TimeSpan.Zero;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            log.Info("updates: stopped after the time limit");
            return CheckEvery;
        }
#pragma warning disable CA1031 // A failed check (no network, no release with the tray, GitHub's limit) waits for the next one.
        catch (Exception e)
#pragma warning restore CA1031
        {
            log.Info($"updates: check failed ({e.GetType().Name})");
            return CheckEvery;
        }
    }

    /**
     * Installs the downloaded update when nothing runs: no run or command of the tray (held), and no run from the
     * command line (the engine's run lock, held by the tray until the install ends this process). False to try again
     * later. An install that cannot start leaves the tray running as it was, and is tried again at the next check.
     */
    internal async Task<bool> TryApplyAsync(CancellationToken cancellationToken)
    {
        _applyFailed = false;
        if (_ready is null || !loop.IsIdle)
            return false;
        using var hold = loop.HoldForInstall();
        if (hold is null)
            return false;
        await using var runLock = await loop.HoldRunLockAsync(cancellationToken).ConfigureAwait(false);
        if (runLock is null)
            return false;
        log.Info("updates: installing");
        try
        {
            updater.Apply(_ready);
            return true;
        }
#pragma warning disable CA1031 // Update.exe blocked or refused: the tray goes on, and says so in its log.
        catch (Exception e)
#pragma warning restore CA1031
        {
            _applyFailed = true;
            log.Info($"updates: install did not start ({e.GetType().Name})");
            return false;
        }
    }
}
