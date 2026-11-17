using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using AdiutorSync.Core;
using Microsoft.Win32;

namespace AdiutorSync;

/// <summary>What the settings window needs from the app.</summary>
internal interface ISettingsHost
{
    SyncLoop Loop { get; }
    Texts Texts { get; }
    string Version { get; }

    /** Saves the settings and applies what changed (language, start with Windows). */
    void Save(TraySettings settings);

    void OpenInBrowser(string url);
}

/// <summary>
/// The settings window (the plan, section 4, "Settings window"): Adiutor's address and its connection, T3's command
/// line, address and connection, the overview folder, the schedule, start with Windows and the language. Every
/// setting is written to settings.json in the data folder; the connections are the engine's commands.
/// </summary>
#pragma warning disable CA1001 // The command's token is disposed when its command ends (RunAsync).
internal sealed partial class SettingsWindow : Window
#pragma warning restore CA1001
{
    public const string DefaultT3Url = "http://127.0.0.1:3773";
    private const int NameMax = 60;

    private readonly ISettingsHost _host;
    private CancellationTokenSource? _command;
    private string? _approvalLink;
    private TraySnapshot? _snapshot;

    public SettingsWindow(ISettingsHost host)
    {
        _host = host;
        InitializeComponent();
        // As tall as its content, within the screen; it scrolls on a small screen.
        MaxHeight = SystemParameters.WorkArea.Height - 40;
        ApplyTexts();
        Fill(host.Loop.Snapshot.Settings);
        Render(host.Loop.Snapshot);
        Closed += (_, _) => _command?.Cancel();
    }

    /** T3's command line where T3 installs it (the engine's default). */
    public static string DefaultT3Cli =>
        Path.Combine(Environment.GetEnvironmentVariable("USERPROFILE") ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".t3", "bin", "t3.cmd");

    private Texts T => _host.Texts;

    public void ApplyTexts()
    {
        var t = T;
        FlowDirection = t.RightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight;
        Title = t["settings.title"];
        Heading.Text = t["settings.title"];
        AdiutorHeading.Text = t["settings.adiutor"];
        AdiutorUrlLabel.Text = t["settings.address"];
        AdiutorConnect.Content = t["settings.connect"];
        AdiutorDisconnect.Content = t["settings.disconnect"];
        OpenApproval.Content = t["settings.openLink"];
        CancelCommand.Content = t["settings.cancel"];
        T3Heading.Text = t["settings.t3"];
        T3CliLabel.Text = t["settings.t3Cli"];
        T3UrlLabel.Text = t["settings.t3Address"];
        T3Connect.Content = t["settings.connect"];
        T3Disconnect.Content = t["settings.disconnect"];
        SyncHeading.Text = t["settings.sync"];
        OverviewLabel.Text = t["settings.overview"];
        BrowseOverview.Content = t["settings.browse"];
        ScheduleLabel.Text = t["settings.schedule"];
        StartBox.Content = t["settings.startWithWindows"];
        StartNote.Text = StartWithWindows.Available ? "" : t["settings.startOnlyInstalled"];
        StartNote.Visibility = StartWithWindows.Available ? Visibility.Collapsed : Visibility.Visible;
        LanguageLabel.Text = t["settings.language"];
        SaveButton.Content = t["settings.save"];
        VersionText.Text = t.Format("settings.version", ("version", TrayView.LeftToRight(_host.Version, t)));

        var hours = (Schedule.SelectedItem as ComboBoxItem)?.Tag as int? ?? TraySettings.DefaultScheduleHours;
        Schedule.Items.Clear();
        foreach (var n in TraySettings.ScheduleChoices)
        {
            var text = n == 1 ? t["settings.hour"] : t.Format("settings.hours", ("n", n.ToString(System.Globalization.CultureInfo.CurrentCulture)));
            Schedule.Items.Add(new ComboBoxItem { Content = text, Tag = n });
        }
        SelectTag(Schedule, hours);
        var language = (LanguageBox.SelectedItem as ComboBoxItem)?.Tag as string ?? t.Language;
        LanguageBox.Items.Clear();
        LanguageBox.Items.Add(new ComboBoxItem { Content = t["settings.hebrew"], Tag = Texts.Hebrew });
        LanguageBox.Items.Add(new ComboBoxItem { Content = t["settings.english"], Tag = Texts.English });
        SelectTag(LanguageBox, language);
        if (_snapshot is not null)
            Render(_snapshot);
    }

    private void Fill(TraySettings s)
    {
        AdiutorUrl.Text = s.AdiutorUrl ?? _host.Loop.Snapshot.Status?.Adiutor.Url ?? "";
        T3Cli.Text = s.T3CliPath ?? DefaultT3Cli;
        T3Url.Text = s.T3Url ?? DefaultT3Url;
        Overview.Text = s.OverviewDir ?? "";
        SelectTag(Schedule, s.ScheduleHours);
        StartBox.IsChecked = s.StartWithWindows;
        SelectTag(LanguageBox, s.Language ?? T.Language);
    }

    private static void SelectTag<TValue>(ComboBox box, TValue value)
    {
        foreach (ComboBoxItem item in box.Items)
        {
            if (Equals(item.Tag, value))
            {
                box.SelectedItem = item;
                return;
            }
        }
    }

    /** Shows the connections' state from the loop's latest snapshot. */
    public void Render(TraySnapshot snapshot)
    {
        _snapshot = snapshot;
        var t = T;
        var busy = _command is not null;
        var adiutor = snapshot.Status?.Adiutor;
        var t3 = snapshot.Status?.T3;
        ShowState(AdiutorState, AdiutorDot, adiutor?.State, adiutor?.RevocationPending == true);
        ShowState(T3State, T3Dot, t3?.State, t3?.RevocationPending == true);
        var engine = !snapshot.EngineMissing;
        AdiutorConnect.IsEnabled = engine && !busy && adiutor?.State != ConnectionState.Connected;
        AdiutorDisconnect.IsEnabled = engine && !busy && (adiutor?.State is ConnectionState.Connected or ConnectionState.Ended || adiutor?.RevocationPending == true);
        T3Connect.IsEnabled = engine && !busy && t3?.State != ConnectionState.Connected;
        T3Disconnect.IsEnabled = engine && !busy && (t3?.State is ConnectionState.Connected or ConnectionState.Ended || t3?.RevocationPending == true);
        SaveButton.IsEnabled = !busy;
        if (!busy)
            ApprovalBox.Visibility = Visibility.Collapsed;
    }

    private void ShowState(TextBlock text, System.Windows.Shapes.Ellipse dot, ConnectionState? state, bool revocationPending)
    {
        var t = T;
        text.Text = state switch
        {
            ConnectionState.Connected => t["settings.connected"],
            ConnectionState.NotConnected => t["settings.notConnected"],
            ConnectionState.Ended => t["settings.ended"],
            _ => t["settings.unknown"],
        } + (revocationPending ? "\n" + t["settings.revocationPending"] : "");
        var colour = IconPainter.ColorOf(state switch
        {
            ConnectionState.Connected => IconState.Synced,
            ConnectionState.Ended or ConnectionState.NotConnected => IconState.NotConnected,
            _ => IconState.Paused,
        });
        dot.Fill = new SolidColorBrush(Color.FromRgb(colour.R, colour.G, colour.B));
    }

    /** The settings in the window, or null with the reason shown when an address is not one the engine accepts. */
    private TraySettings? Collect()
    {
        var t = T;
        AdiutorMessage.Text = "";
        T3Message.Text = "";
        string? adiutor = null;
        if (AdiutorUrl.Text.Trim().Length > 0)
        {
            adiutor = Addresses.Origin(AdiutorUrl.Text);
            if (adiutor is null)
            {
                AdiutorMessage.Text = t["settings.badAdiutorUrl"];
                return null;
            }
        }
        string? t3Url = null;
        if (T3Url.Text.Trim().Length > 0)
        {
            t3Url = Addresses.Origin(T3Url.Text);
            if (t3Url is null)
            {
                T3Message.Text = t["settings.badT3Url"];
                return null;
            }
            if (t3Url == DefaultT3Url)
                t3Url = null;
        }
        var cli = T3Cli.Text.Trim();
        var current = _host.Loop.Snapshot.Settings;
        return current with
        {
            AdiutorUrl = adiutor,
            T3Url = t3Url,
            // The default is not written, so the engine keeps finding T3 where T3 installs it.
            T3CliPath = cli.Length == 0 || string.Equals(cli, DefaultT3Cli, StringComparison.OrdinalIgnoreCase) ? null : cli,
            OverviewDir = Overview.Text.Trim().Length == 0 ? null : Overview.Text.Trim(),
            ScheduleHours = (Schedule.SelectedItem as ComboBoxItem)?.Tag as int? ?? TraySettings.DefaultScheduleHours,
            StartWithWindows = StartBox.IsChecked == true,
            Language = (LanguageBox.SelectedItem as ComboBoxItem)?.Tag as string,
        };
    }

    private void Save_Click(object sender, RoutedEventArgs e)
    {
        if (Collect() is not { } settings)
            return;
        _host.Save(settings);
        SaveMessage.Text = T["settings.saved"];
    }

    private async void AdiutorConnect_Click(object sender, RoutedEventArgs e)
    {
        if (Collect() is not { } settings)
            return;
        if (settings.AdiutorUrl is not { } url)
        {
            AdiutorMessage.Text = T["settings.addressFirst"];
            return;
        }
        _host.Save(settings);
        var status = _host.Loop.Snapshot.Status?.Adiutor;
        List<string> args = ["connect", "--name", ConnectionName(), "--url", url];
        // An ended connection for this address is connected again; the engine then ends the old one.
        if (status is { State: ConnectionState.Ended } && Addresses.Origin(status.Url) == url)
            args.Add("--replace");
        await RunAsync(args, AdiutorMessage, ok => ok.ConnectState is "connected" or "already_connected" ? T["settings.connectedNow"] : null);
    }

    private async void AdiutorDisconnect_Click(object sender, RoutedEventArgs e)
    {
        List<string> args = ["disconnect"];
        if (Addresses.Origin(_host.Loop.Snapshot.Status?.Adiutor.Url) is { } url)
            args.AddRange(["--url", url]);
        await RunAsync(args, AdiutorMessage, _ => T["settings.disconnectedNow"]);
    }

    private async void T3Connect_Click(object sender, RoutedEventArgs e)
    {
        if (Collect() is not { } settings)
            return;
        _host.Save(settings);
        await RunAsync(["t3-connect"], T3Message, _ => T["settings.connectedNow"]);
    }

    private async void T3Disconnect_Click(object sender, RoutedEventArgs e) =>
        await RunAsync(["t3-disconnect"], T3Message, _ => T["settings.disconnectedNow"]);

    /** Runs one engine command of this window; only one at a time. */
    private async Task RunAsync(List<string> args, TextBlock message, Func<EngineResult, string?> success)
    {
        if (_command is not null)
            return;
        _command = new CancellationTokenSource();
        message.Text = T["settings.working"];
        Render(_host.Loop.Snapshot);
        try
        {
            var outcome = await _host.Loop.RunCommandAsync(args, OnEvent, _command.Token);
            message.Text = outcome.Result is { Ok: true } ok && success(ok) is { } text
                ? text
                : T.Format("settings.failed", ("code", NodeEngine.SafeCode(outcome.Result?.Error?.Code ?? outcome.Failure ?? "no_result")));
        }
        finally
        {
            _command.Dispose();
            _command = null;
            _approvalLink = null;
            Render(_host.Loop.Snapshot);
        }
    }

    /** The approval link and code of `connect`, shown while the owner approves in the browser the engine opened. */
    private void OnEvent(EngineEvent e)
    {
        if (e is not ApprovalEvent approval)
            return;
        Dispatcher.BeginInvoke(() =>
        {
            if (_command is null)
                return;
            _approvalLink = TrayView.OpenableUrl(approval.Link);
            ApprovalText.Text = T.Format("settings.approve", ("code", approval.UserCode));
            ApprovalCode.Text = approval.UserCode;
            OpenApproval.IsEnabled = _approvalLink is not null;
            ApprovalBox.Visibility = Visibility.Visible;
        });
    }

    private void OpenApproval_Click(object sender, RoutedEventArgs e)
    {
        if (_approvalLink is { } link)
            _host.OpenInBrowser(link);
    }

    private void Cancel_Click(object sender, RoutedEventArgs e) => _command?.Cancel();

    private void BrowseOverview_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog { Title = T["settings.overview"] };
        if (Directory.Exists(Overview.Text.Trim()))
            dialog.InitialDirectory = Overview.Text.Trim();
        if (dialog.ShowDialog(this) == true)
            Overview.Text = dialog.FolderName;
    }

    /** The name Adiutor's approval page and Settings, Agent access show for this connection. */
    private static string ConnectionName()
    {
        var name = $"Adiutor Sync ({Environment.MachineName})";
        return name.Length <= NameMax ? name : name[..NameMax];
    }
}
