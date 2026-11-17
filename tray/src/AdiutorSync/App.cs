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
    private bool _exiting;

    public SyncLoop Loop { get; private set; } = null!;

    public Texts Texts { get; private set; } = null!;

    public string Version { get; } = TrayVersion.FromInformational(
        typeof(App).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion);

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        ThemeMode = ThemeMode.System;
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        _log = new TrayLog(Path.Combine(_dataFolder, "tray.log"));
        _log.Info($"start {Version}");
        DispatcherUnhandledException += (_, args) => _log.Info($"error {args.Exception.GetType().Name}");

        var settings = SettingsStore.Load(Path.Combine(_dataFolder, TraySettings.FileName)).Settings;
        Texts = Texts.Load(Texts.Choose(settings.Language, CultureInfo.CurrentUICulture));
        Loop = new SyncLoop(CreateEngine(settings), _dataFolder, TimeProvider.System, Version, _log);
        _tray = new TrayIcon(Texts["appName"]);
        _tray.Clicked += TogglePanel;
        Loop.Changed += snapshot => Dispatcher.BeginInvoke(() => Render(snapshot));
        Loop.Notify += notice => Dispatcher.BeginInvoke(() => ShowNotice(notice));
        ApplyStartup(settings.StartWithWindows);
        Render(Loop.Snapshot);
        _ = RunLoopAsync();
        _ = RunUpdatesAsync();
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
        ExitTray();
    }

    private async Task RunUpdatesAsync()
    {
        try
        {
            var updater = new VelopackUpdater(() => Dispatcher.Invoke(() =>
            {
                _tray?.Dispose();
                _tray = null;
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

    private void ExitTray()
    {
        if (_exiting)
            return;
        _exiting = true;
        _stop.Cancel();
        _settingsWindow?.Close();
        _panel?.Close();
        _tray?.Dispose();
        _tray = null;
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
    }

    /** Local time in Windows' own date and time format. */
    private static string FormatTime(DateTimeOffset at) => at.ToLocalTime().ToString("g", CultureInfo.CurrentCulture);

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

    public void Save(TraySettings settings)
    {
        var before = Loop.Snapshot.Settings;
        Loop.SaveSettings(settings);
        if (before.Language != settings.Language)
        {
            Texts = Texts.Load(Texts.Choose(settings.Language, CultureInfo.CurrentUICulture));
            _panel?.ApplyTexts(Texts);
            _settingsWindow?.ApplyTexts();
        }
        if (before.StartWithWindows != settings.StartWithWindows)
            ApplyStartup(settings.StartWithWindows);
        Render(Loop.Snapshot);
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
