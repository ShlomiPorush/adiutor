namespace AdiutorSync.Core;

/**
 * The engine's run lock, held by `hold-run` for the tray until the lease is disposed. `Holds` turns false, and
 * `Lost` is cancelled, as soon as hold-run ends on its own (it crashed, or its limit passed): the tray then no longer
 * holds the lock, and an update must not go on as if it did.
 */
public sealed class RunLockLease : IAsyncDisposable
{
    private readonly Task _holding;
    private readonly TaskCompletionSource _release;
    private readonly CancellationTokenSource _lost = new();

    internal RunLockLease(Task holding, TaskCompletionSource release)
    {
        _holding = holding;
        _release = release;
        _ = holding.ContinueWith(_ => Cancel(), TaskScheduler.Default);
    }

    public bool Holds => !_holding.IsCompleted;

    public CancellationToken Lost => _lost.Token;

    public async ValueTask DisposeAsync()
    {
        _release.TrySetResult();
        await _holding.ConfigureAwait(false);
        _lost.Dispose();
    }

    private void Cancel()
    {
        try
        {
            _lost.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }
    }
}
