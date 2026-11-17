using System.Windows;
using System.Windows.Media;
using AdiutorSync.Core;

namespace AdiutorSync;

/// <summary>What the panel's buttons do; the app carries them out.</summary>
internal interface ITrayActions
{
    void SyncNow();
    void PauseFor(TimeSpan? duration);
    void Resume();
    void OpenAdiutor();
    void OpenSettings();
    void Quit();
}

/// <summary>
/// The panel a click on the icon opens, above the notification area (the plan, section 4, "Tray"): the state, the
/// last run per part and its time, the last good sync, the next run, Sync now, Pause or Resume, Open Adiutor,
/// Settings and Quit. It closes when it loses focus.
/// </summary>
internal sealed partial class PanelWindow : Window
{
    private readonly ITrayActions _actions;
    private PanelView? _view;

    public PanelWindow(ITrayActions actions)
    {
        _actions = actions;
        InitializeComponent();
        Deactivated += (_, _) =>
        {
            HiddenAt = DateTime.UtcNow;
            Hide();
        };
    }

    /** When the panel last closed on losing focus: a click on the icon that caused it does not open it again. */
    public DateTime HiddenAt { get; private set; }

    public void ApplyTexts(Texts t)
    {
        FlowDirection = t.RightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight;
        AppName.Text = t["appName"];
        T3Label.Text = t["panel.t3"];
        SecurityLabel.Text = t["panel.security"];
        LastRunLabel.Text = t["panel.lastRun"];
        LastGoodLabel.Text = t["panel.lastGood"];
        NextRunLabel.Text = t["panel.nextRun"];
        SyncNowButton.Content = t["panel.syncNow"];
        PauseButton.Content = t["panel.pause"] + "  ▾";
        Pause1h.Header = t["panel.pause1h"];
        Pause4h.Header = t["panel.pause4h"];
        PauseOpen.Header = t["panel.pauseUntilResumed"];
        ResumeButton.Content = t["panel.resume"];
        OpenAdiutorButton.Content = t["panel.openAdiutor"];
        SettingsButton.Content = t["panel.settings"];
        QuitButton.Content = t["panel.quit"];
    }

    public void Render(PanelView view)
    {
        _view = view;
        var colour = IconPainter.ColorOf(view.Icon);
        StateDot.Fill = new SolidColorBrush(Color.FromRgb(colour.R, colour.G, colour.B));
        StateText.Text = view.State;
        T3Value.Text = view.T3;
        SecurityValue.Text = view.Security;
        LastRunValue.Text = view.LastRun;
        LastGoodValue.Text = view.LastGood;
        NextRunValue.Text = view.NextRun;
        Notices.ItemsSource = view.Notices;
        Notices.Visibility = view.Notices.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        SyncNowButton.IsEnabled = view.CanSyncNow;
        PauseButton.Visibility = view.Paused ? Visibility.Collapsed : Visibility.Visible;
        PauseButton.IsEnabled = view.CanPause;
        ResumeButton.Visibility = view.Paused ? Visibility.Visible : Visibility.Collapsed;
        ResumeButton.IsEnabled = view.CanPause;
        OpenAdiutorButton.IsEnabled = view.AdiutorUrl is not null;
    }

    /** Opens above the notification area, at the work area's corner on the side of the notification area. */
    public void OpenNearTray()
    {
        Show();
        UpdateLayout();
        var area = SystemParameters.WorkArea;
        Left = area.Right - ActualWidth - 12;
        Top = area.Bottom - ActualHeight - 12;
        Activate();
    }

    private void SyncNow_Click(object sender, RoutedEventArgs e) => _actions.SyncNow();

    private void Pause_Click(object sender, RoutedEventArgs e)
    {
        PauseMenu.PlacementTarget = PauseButton;
        PauseMenu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
        PauseMenu.FlowDirection = FlowDirection;
        PauseMenu.IsOpen = true;
    }

    private void Pause1h_Click(object sender, RoutedEventArgs e) => _actions.PauseFor(TimeSpan.FromHours(1));

    private void Pause4h_Click(object sender, RoutedEventArgs e) => _actions.PauseFor(TimeSpan.FromHours(4));

    private void PauseOpen_Click(object sender, RoutedEventArgs e) => _actions.PauseFor(null);

    private void Resume_Click(object sender, RoutedEventArgs e) => _actions.Resume();

    private void OpenAdiutor_Click(object sender, RoutedEventArgs e)
    {
        Hide();
        _actions.OpenAdiutor();
    }

    private void Settings_Click(object sender, RoutedEventArgs e)
    {
        Hide();
        _actions.OpenSettings();
    }

    private void Quit_Click(object sender, RoutedEventArgs e) => _actions.Quit();
}
