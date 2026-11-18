using System.Diagnostics;
using System.IO;
using System.Globalization;
using System.Reflection;
using System.Windows;
using AdiutorSync.Core;

namespace AdiutorSync;

/// <summary>
/// The tray app: finds the engine and starts it only inside the Job Object, runs the loop on a background task, shows
/// the icon, the panel and the settings window, shows the two notifications, and lets Velopack update it. The theme
/// follows Windows (light and dark); the language is Hebrew (right to left) or English.
/// </summary>
#pragma warning disable CA1001 // The app owns its job, icon and token for its whole life; ExitTray disposes them before Shutdown.
internal sealed class App : Application, ITrayActions, ISettingsHost
#pragma warning restore CA1001
{
    private static readonly TimeSpan ReopenGuard = TimeSpan.FromMilliseconds(400);

    private readonly string _dataFolder = DataFolder.Resolve();
    private readonly CancellationTokenSource _stop = new();
    private TrayLog _log = null!;
    private EngineJob? _job;
    private TrayIcon? _tray;
    private PanelWindow? _panel;
    private SettingsWindow? _settingsWindow;
    private readonly EventWaitHandle _showPanel;
    // The first start after the install opens the panel once the engine's first status is known (read, refused or no
    // engine), so it never opens on "could not read the sync's state".
    private bool _firstRunPanel;
    private bool _exiting;

    public App(EventWaitHandle showPanel, bool firstRun)
    {
        _showPanel = showPanel;
        _firstRunPanel = firstRun;
    }

    public SyncLoop Loop { get; private set; } = null!;

    public Texts Texts { get; private set; } = null!;

    public string Version { get; } = TrayVersion.FromInformational(
        typeof(App).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion);

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        ThemeMode = ThemeMode.System;
        Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri("pack://application:,,,/AdiutorSync;component/Theme.xaml") });
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        _log = new TrayLog(Path.Combine(_dataFolder, "tray.log"));
        _log.Info($"start {Version}");
        DispatcherUnhandledException += (_, args) => _log.Info($"error {args.Exception.GetType().Name}");

        var settings = SettingsStore.Load(Path.Combine(_dataFolder, TraySettings.FileName)).Settings;
        Texts = Texts.Load(Texts.Choose(settings.Language, CultureInfo.CurrentUICulture));
        Loop = new SyncLoop(CreateEngine(settings), _dataFolder, TimeProvider.System, Version, _log);
        ShowTrayIcon();
        Loop.Changed += snapshot => Dispatcher.BeginInvoke(() => Render(snapshot));
        Loop.Notify += notice => Dispatcher.BeginInvoke(() => ShowNotice(notice));
        ApplyStartup(settings.StartWithWindows);
        Render(Loop.Snapshot);
        _ = RunLoopAsync();
        _ = RunUpdatesAsync();
        _ = WaitForShowAsync();
    }

    /** Another start of the app asks this one to open its panel. */
    private async Task WaitForShowAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            var signalled = await Task.Run(() => WaitHandle.WaitAny([_showPanel, _stop.Token.WaitHandle]) == 0);
            if (signalled && !_exiting && _panel is not { IsVisible: true })
                TogglePanel();
        }
    }

    private void ShowTrayIcon()
    {
        if (_tray is not null || _exiting)
            return;
        _tray = new TrayIcon(Texts["appName"]);
        _tray.Clicked += TogglePanel;
        // A new icon (also the one put back after an update that did not start) can get a new key in Explorer.
        TrayIconPromotion.PromoteInBackground(_log);
    }

    private NodeEngine? CreateEngine(TraySettings settings)
    {
        var location = EngineLocator.Find(AppContext.BaseDirectory, settings.EnginePath, Environment.GetEnvironmentVariable);
        if (location is null)
        {
            _log.Info("engine not found");
            return null;
        }
        try
        {
            _job = new EngineJob();
            return new NodeEngine(location, _job, _log);
        }
        catch (InvalidOperationException)
        {
            // Never run the engine outside the job.
            _log.Info("job object not created; the engine does not run");
            return null;
        }
    }

    private async Task RunLoopAsync()
    {
        try
        {
            await Task.Run(() => Loop.RunAsync(_stop.Token));
        }
#pragma warning disable CA1031 // The loop ending for any reason ends the tray, which says so in its log.
        catch (Exception e)
#pragma warning restore CA1031
        {
            _log.Info($"loop stopped ({e.GetType().Name})");
        }
        await ExitTrayAsync();
    }

    private async Task RunUpdatesAsync()
    {
        try
        {
            var updater = new VelopackUpdater(
                () => Dispatcher.Invoke(() =>
                {
                    _tray?.Dispose();
                    _tray = null;
                }),
                // The install did not start: the tray goes on, with its icon.
                () => Dispatcher.Invoke(() =>
                {
                    ShowTrayIcon();
                    Render(Loop.Snapshot);
                }));
            await Task.Run(() => new UpdateCoordinator(Loop, updater, TimeProvider.System, _log).RunAsync(_stop.Token));
        }
        catch (OperationCanceledException)
        {
        }
#pragma warning disable CA1031 // Updates are optional: the tray goes on without them and says so in its log.
        catch (Exception e)
#pragma warning restore CA1031
        {
            _log.Info($"updates stopped ({e.GetType().Name})");
        }
    }

    private async Task ExitTrayAsync()
    {
        if (_exiting)
            return;
        _exiting = true;
        _stop.Cancel();
        // Closing the settings window cancels its command (connect waits for an approval); no command starts after
        // this, and those under way end before the job closes.
        _settingsWindow?.Close();
        _panel?.Close();
        _tray?.Dispose();
        _tray = null;
        await Loop.CloseAsync(TimeSpan.FromSeconds(15));
        _job?.Dispose();
        _log.Info("exit");
        Shutdown();
    }

    private void Render(TraySnapshot snapshot)
    {
        if (_exiting)
            return;
        var view = TrayView.Build(snapshot, Texts, FormatTime);
        _tray?.Show(view.Icon, view.Tooltip);
        _panel?.Render(view);
        _settingsWindow?.Render(snapshot);
        if (_firstRunPanel && (snapshot.Status is not null || snapshot.StatusProblem is not null || snapshot.EngineMissing))
        {
            _log.Info("first run after the install: panel opened");
            TogglePanel();
        }
    }

    private string FormatTime(DateTimeOffset at) => TrayView.LocalTime(at, Texts, CultureInfo.CurrentCulture);

    private void ShowNotice(Notice notice)
    {
        var (title, body) = notice switch
        {
            Notice.ScheduledRunsNotGood => (Texts["notify.runsNotGoodTitle"], Texts["notify.runsNotGoodBody"]),
            Notice.AdiutorConnectionEnded => (Texts["notify.adiutorEndedTitle"], Texts["notify.endedBody"]),
            _ => (Texts["notify.t3EndedTitle"], Texts["notify.endedBody"]),
        };
        _tray?.Notify(title, body);
    }

    private void TogglePanel()
    {
        // A panel the owner opened or closed already answers the first run's opening.
        _firstRunPanel = false;
        if (_panel is { IsVisible: true })
        {
            _panel.Hide();
            return;
        }
        // The click on the icon that took the focus from the open panel closed it; it does not open it again.
        if (_panel is not null && DateTime.UtcNow - _panel.HiddenAt < ReopenGuard)
            return;
        if (_panel is null)
        {
            _panel = new PanelWindow(this);
            _panel.ApplyTexts(Texts);
        }
        _panel.Render(TrayView.Build(Loop.Snapshot, Texts, FormatTime));
        _panel.OpenNearTray();
    }

    // --- ITrayActions ---

    public void SyncNow() => Loop.SyncNow();

    // A pause or resume that could not be written shows as a notice in the panel; nothing else changes.
    public void PauseFor(TimeSpan? duration) => Loop.PauseFor(duration);

    public void Resume() => Loop.Resume();

    public void OpenAdiutor()
    {
        var snapshot = Loop.Snapshot;
        if (TrayView.OpenableUrl(snapshot.Status?.Adiutor.Url ?? snapshot.Settings.AdiutorUrl) is { } url)
            OpenInBrowser(url);
    }

    public void OpenSettings()
    {
        if (_settingsWindow is null)
        {
            _settingsWindow = new SettingsWindow(this);
            _settingsWindow.Closed += (_, _) => _settingsWindow = null;
        }
        _settingsWindow.Show();
        _settingsWindow.Activate();
    }

    public void Quit()
    {
        _log.Info("quit asked");
        Loop.RequestQuit();
    }

    // --- ISettingsHost ---

    public bool Save(TraySettings settings)
    {
        var before = Loop.Snapshot.Settings;
        if (!Loop.SaveSettings(settings))
        {
            Render(Loop.Snapshot);
            return false;
        }
        if (before.Language != settings.Language)
        {
            Texts = Texts.Load(Texts.Choose(settings.Language, CultureInfo.CurrentUICulture));
            _panel?.ApplyTexts(Texts);
            _settingsWindow?.ApplyTexts();
        }
        if (before.StartWithWindows != settings.StartWithWindows)
            ApplyStartup(settings.StartWithWindows);
        Render(Loop.Snapshot);
        return true;
    }

    public void OpenInBrowser(string url)
    {
        if (TrayView.OpenableUrl(url) is not { } safe)
            return;
        try
        {
            Process.Start(new ProcessStartInfo(safe) { UseShellExecute = true })?.Dispose();
        }
        catch (System.ComponentModel.Win32Exception)
        {
            _log.Info("browser not opened");
        }
    }

    private void ApplyStartup(bool on)
    {
        try
        {
            AdiutorSync.StartWithWindows.Apply(on);
        }
#pragma warning disable CA1031 // A shortcut that cannot be written leaves the tray running; the log says so.
        catch (Exception e)
#pragma warning restore CA1031
        {
            _log.Info($"start with Windows not changed ({e.GetType().Name})");
        }
    }
}
