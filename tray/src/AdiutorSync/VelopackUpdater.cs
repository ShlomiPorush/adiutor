using AdiutorSync.Core;
using Velopack;
using Velopack.Sources;

namespace AdiutorSync;

/// <summary>
/// Velopack's update manager against the GitHub Releases of this repository (owner's decision D-T7), through its
/// documented API only: check, download, then apply and restart. No token: releases are public.
/// </summary>
internal sealed class VelopackUpdater(Action beforeApply) : IAppUpdater
{
    public const string Repository = "https://github.com/ShlomiPorush/adiutor";

    private readonly UpdateManager _manager = new(new GithubSource(Repository, accessToken: null, prerelease: false));

    public bool IsInstalled => _manager.IsInstalled;

    public async Task<object?> CheckAsync(CancellationToken cancellationToken) =>
        await _manager.CheckForUpdatesAsync().WaitAsync(cancellationToken).ConfigureAwait(false);

    public Task DownloadAsync(object update, CancellationToken cancellationToken) =>
        _manager.DownloadUpdatesAsync((UpdateInfo)update, progress: null, cancellationToken);

    public void Apply(object update)
    {
        beforeApply();
        _manager.ApplyUpdatesAndRestart(((UpdateInfo)update).TargetFullRelease);
    }
}
