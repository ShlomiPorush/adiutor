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

    /** Saves the settings and applies what changed (language, start with Windows); false when not written. */
    bool Save(TraySettings settings);

    void OpenInBrowser(string url);
}

/// <summary>
/// The settings window (the plan, section 4, "Settings window"): Adiutor's address and its connection, T3's command
/// line, address and connection, the overview folder, the schedule, start with Windows and the language. Every
/// setting is written to settings.json in the data folder; the connections are the engine's commands. Each area starts
/// closed with its state in its header, and opens when the owner clicks it or when it needs the owner
/// (SettingsSections).
/// </summary>
#pragma warning disable CA1001 // The command's token is disposed when its command ends (RunAsync).
internal sealed partial class SettingsWindow : Window
#pragma warning restore CA1001
{
    public const string DefaultT3Url = "http://127.0.0.1:3773";

    private readonly ISettingsHost _host;
    private CancellationTokenSource? _command;
    private string? _approvalLink;
    private TraySnapshot? _snapshot;
    private readonly SectionAttention _adiutorAttention = new();
    private readonly SectionAttention _t3Attention = new();

    public SettingsWindow(ISettingsHost host)
    {
        _host = host;
        InitializeComponent();
        // As tall as its content, within the screen; it scrolls on a small screen.
        MaxHeight = SystemParameters.WorkArea.Height - 40;
        ApplyTexts();
        Fill(host.Loop.Snapshot.Settings);
        Render(host.Loop.Snapshot);
        Schedule.SelectionChanged += (_, _) => ShowSyncSummary();
        Overview.TextChanged += (_, _) => ShowSyncSummary();
        ShowSyncSummary();
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
            Schedule.Items.Add(new ComboBoxItem { Content = SettingsSections.ScheduleChoice(t, n), Tag = n });
        SelectTag(Schedule, hours);
        var language = (LanguageBox.SelectedItem as ComboBoxItem)?.Tag as string ?? t.Language;
        LanguageBox.Items.Clear();
        LanguageBox.Items.Add(new ComboBoxItem { Content = t["settings.hebrew"], Tag = Texts.Hebrew });
        LanguageBox.Items.Add(new ComboBoxItem { Content = t["settings.english"], Tag = Texts.English });
        SelectTag(LanguageBox, language);
        ShowSyncSummary();
        if (_snapshot is not null)
        {
            Render(_snapshot);
            ApplyModes();
        }
    }

    /** Each setting as the engine uses it (its status), falling back to the settings file before a status was read. */
    private void Fill(TraySettings s)
    {
        ShowEffective(s);
        SelectTag(Schedule, s.ScheduleHours);
        StartBox.IsChecked = s.StartWithWindows;
        SelectTag(LanguageBox, s.Language ?? T.Language);
    }

    /** Each address field's baseline: a field whose text differs from it is being edited, and is left alone. */
    private readonly Dictionary<TextBox, FieldState> _shown = [];

    /** Shows each setting as the engine uses it; called again when a newer status arrives. */
    private void ShowEffective(TraySettings s)
    {
        Show(AdiutorUrl, EffectiveSettings.AdiutorUrl, Effective(EffectiveSettings.AdiutorUrl)?.Value ?? s.AdiutorUrl ?? _host.Loop.Snapshot.Status?.Adiutor.Url ?? "");
        Show(T3Cli, EffectiveSettings.T3CliPath, Effective(EffectiveSettings.T3CliPath)?.Value ?? s.T3CliPath ?? DefaultT3Cli);
        Show(T3Url, EffectiveSettings.T3Url, Effective(EffectiveSettings.T3Url)?.Value ?? s.T3Url ?? DefaultT3Url);
        Show(Overview, EffectiveSettings.OverviewDir, Effective(EffectiveSettings.OverviewDir)?.Value ?? s.OverviewDir ?? "");
        ApplyModes();
    }

    private void Show(TextBox box, string key, string value)
    {
        if (!_shown.TryGetValue(box, out var state))
            _shown[box] = state = new FieldState();
        box.Text = state.Refresh(box.Text, value, IsLocked(key));
    }

    /** After a save, what the fields show is no longer a draft. */
    private void MarkSaved()
    {
        foreach (var box in new[] { AdiutorUrl, T3Cli, T3Url, Overview })
        {
            if (_shown.TryGetValue(box, out var state))
                state.Saved(box.Text);
        }
    }

    private EffectiveSetting? Effective(string key) =>
        _host.Loop.Snapshot.Status?.Settings is { } values && values.TryGetValue(key, out var value) ? value : null;

    private bool IsLocked(string key) =>
        EffectiveSettings.Mode(key, Effective(key)?.Source) is FieldMode.LockedByEnvironment or FieldMode.LockedByEnvFile;

    /**
     * A setting the environment or an env file sets is shown locked, with a note saying so (the owner's rule); Adiutor's
     * address from sync.env stays editable, since Connect writes it there.
     */
    private void ApplyModes()
    {
        ApplyMode(AdiutorUrl, AdiutorUrlNote, EffectiveSettings.AdiutorUrl);
        ApplyMode(T3Cli, T3CliNote, EffectiveSettings.T3CliPath);
        ApplyMode(T3Url, T3UrlNote, EffectiveSettings.T3Url);
        ApplyMode(Overview, OverviewNote, EffectiveSettings.OverviewDir);
        BrowseOverview.IsEnabled = !IsLocked(EffectiveSettings.OverviewDir);
    }

    private void ApplyMode(TextBox box, TextBlock note, string key)
    {
        var t = T;
        var mode = EffectiveSettings.Mode(key, Effective(key)?.Source);
        box.IsReadOnly = mode is FieldMode.LockedByEnvironment or FieldMode.LockedByEnvFile;
        note.Text = mode switch
        {
            FieldMode.LockedByEnvironment => t.Format("settings.lockedEnvironment", ("name", EffectiveSettings.EnvironmentName(key))),
            FieldMode.LockedByEnvFile => t.Format("settings.lockedEnvFile", ("name", EffectiveSettings.EnvironmentName(key))),
            FieldMode.EditableUntilConnect => t["settings.urlFromConnect"],
            _ => "",
        };
        note.Visibility = note.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
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
        // A status that arrived after the window opened brings the values the engine uses, and their locks.
        if (_shown.Count > 0)
            ShowEffective(snapshot.Settings);
        var t = T;
        var busy = _command is not null;
        var adiutor = snapshot.Status?.Adiutor;
        var t3 = snapshot.Status?.T3;
        ShowState(AdiutorState, AdiutorDot, AdiutorPending, adiutor?.State, adiutor?.RevocationPending == true,
            adiutor?.State == ConnectionState.Connected ? Addresses.Origin(adiutor.Url) : null);
        ShowState(T3State, T3Dot, T3Pending, t3?.State, t3?.RevocationPending == true, null);
        if (_adiutorAttention.Update(SettingsSections.NeedsAttention(adiutor?.State, adiutor?.RevocationPending == true)))
            AdiutorSection.IsExpanded = true;
        if (_t3Attention.Update(SettingsSections.NeedsAttention(t3?.State, t3?.RevocationPending == true)))
            T3Section.IsExpanded = true;
        var engine = !snapshot.EngineMissing;
        AdiutorConnect.IsEnabled = engine && !busy && adiutor?.State != ConnectionState.Connected;
        AdiutorDisconnect.IsEnabled = engine && !busy && (adiutor?.State is ConnectionState.Connected or ConnectionState.Ended || adiutor?.RevocationPending == true);
        T3Connect.IsEnabled = engine && !busy && t3?.State != ConnectionState.Connected;
        T3Disconnect.IsEnabled = engine && !busy && (t3?.State is ConnectionState.Connected or ConnectionState.Ended || t3?.RevocationPending == true);
        SaveButton.IsEnabled = !busy;
        if (!busy)
            ApprovalBox.Visibility = Visibility.Collapsed;
    }

    /** A connection's state in its area's header (with the address it is connected to), and an unfinished disconnect inside. */
    private void ShowState(TextBlock text, System.Windows.Shapes.Ellipse dot, TextBlock pending, ConnectionState? state, bool revocationPending, string? address)
    {
        var t = T;
        text.Text = state switch
        {
            ConnectionState.Connected => t["settings.connected"],
            ConnectionState.NotConnected => t["settings.notConnected"],
            ConnectionState.Ended => t["settings.ended"],
            _ => t["settings.unknown"],
        } + (address is null ? "" : " · " + TrayView.LeftToRight(new Uri(address).Authority, t));
        pending.Text = revocationPending ? t["settings.revocationPending"] : "";
        pending.Visibility = revocationPending ? Visibility.Visible : Visibility.Collapsed;
        var colour = IconPainter.ColorOf(state switch
        {
            ConnectionState.Connected => IconState.Synced,
            ConnectionState.Ended or ConnectionState.NotConnected => IconState.NotConnected,
            _ => IconState.Paused,
        });
        dot.Fill = new SolidColorBrush(Color.FromRgb(colour.R, colour.G, colour.B));
    }

    /** The Sync area's header, from what its fields show now. */
    private void ShowSyncSummary() =>
        SyncSummary.Text = SettingsSections.SyncSummary(T, (Schedule.SelectedItem as ComboBoxItem)?.Tag as int? ?? TraySettings.DefaultScheduleHours, Overview.Text);

    /** A message of an area is never hidden: its area opens. */
    private void Say(TextBlock message, string text)
    {
        message.Text = text;
        if (text.Length == 0)
            return;
        if (message == AdiutorMessage)
            AdiutorSection.IsExpanded = true;
        else if (message == T3Message)
            T3Section.IsExpanded = true;
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
                Say(AdiutorMessage, t["settings.badAdiutorUrl"]);
                return null;
            }
        }
        string? t3Url = null;
        if (T3Url.Text.Trim().Length > 0)
        {
            t3Url = Addresses.Origin(T3Url.Text);
            if (t3Url is null)
            {
                Say(T3Message, t["settings.badT3Url"]);
                return null;
            }
            if (t3Url == DefaultT3Url)
                t3Url = null;
        }
        var cli = T3Cli.Text.Trim();
        var current = _host.Loop.Snapshot.Settings;
        // A locked field shows the environment's value, which is never written to the settings file.
        return current with
        {
            AdiutorUrl = IsLocked(EffectiveSettings.AdiutorUrl) ? current.AdiutorUrl : adiutor,
            T3Url = IsLocked(EffectiveSettings.T3Url) ? current.T3Url : t3Url,
            // The default is not written, so the engine keeps finding T3 where T3 installs it.
            T3CliPath = IsLocked(EffectiveSettings.T3CliPath) ? current.T3CliPath
                : cli.Length == 0 || string.Equals(cli, DefaultT3Cli, StringComparison.OrdinalIgnoreCase) ? null : cli,
            OverviewDir = IsLocked(EffectiveSettings.OverviewDir) ? current.OverviewDir
                : Overview.Text.Trim().Length == 0 ? null : Overview.Text.Trim(),
            ScheduleHours = (Schedule.SelectedItem as ComboBoxItem)?.Tag as int? ?? TraySettings.DefaultScheduleHours,
            StartWithWindows = StartBox.IsChecked == true,
            Language = (LanguageBox.SelectedItem as ComboBoxItem)?.Tag as string,
        };
    }

    private void Save_Click(object sender, RoutedEventArgs e)
    {
        if (Collect() is not { } settings)
            return;
        if (!_host.Save(settings))
        {
            SaveMessage.Text = T["settings.notSaved"];
            return;
        }
        MarkSaved();
        SaveMessage.Text = T["settings.saved"];
    }

    private async void AdiutorConnect_Click(object sender, RoutedEventArgs e)
    {
        if (Collect() is not { } settings)
            return;
        // Set by the environment: no --url, the engine uses its own address. Otherwise the address the owner saved.
        var url = ConnectCommand.UrlArgument(Effective(EffectiveSettings.AdiutorUrl)?.Source, settings.AdiutorUrl);
        var effective = url ?? Addresses.Origin(Effective(EffectiveSettings.AdiutorUrl)?.Value);
        if (effective is null)
        {
            Say(AdiutorMessage, T["settings.addressFirst"]);
            return;
        }
        if (!_host.Save(settings))
        {
            Say(AdiutorMessage, T["settings.notSaved"]);
            return;
        }
        MarkSaved();
        var status = _host.Loop.Snapshot.Status?.Adiutor;
        // An ended connection for this address is connected again; the engine then ends the old one.
        var args = ConnectCommand.Args(Environment.MachineName, url, status is { State: ConnectionState.Ended } && Addresses.Origin(status.Url) == effective);
        await RunAsync(args, AdiutorMessage, ok => ok.ConnectState is "connected" or "already_connected" ? T["settings.connectedNow"] : null);
    }

    private async void AdiutorDisconnect_Click(object sender, RoutedEventArgs e)
    {
        List<string> args = ["disconnect"];
        if (ConnectCommand.UrlArgument(Effective(EffectiveSettings.AdiutorUrl)?.Source, Addresses.Origin(_host.Loop.Snapshot.Status?.Adiutor.Url)) is { } url)
            args.AddRange(["--url", url]);
        await RunAsync(args, AdiutorMessage, _ => T["settings.disconnectedNow"]);
    }

    private async void T3Connect_Click(object sender, RoutedEventArgs e)
    {
        if (Collect() is not { } settings)
            return;
        if (!_host.Save(settings))
        {
            Say(T3Message, T["settings.notSaved"]);
            return;
        }
        MarkSaved();
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
        Say(message, T["settings.working"]);
        Render(_host.Loop.Snapshot);
        try
        {
            var outcome = await _host.Loop.RunCommandAsync(args, OnEvent, _command.Token);
            Say(message, outcome.Result is { Ok: true } ok && success(ok) is { } text
                ? text
                : T.Format("settings.failed", ("code", NodeEngine.SafeCode(outcome.Result?.Error?.Code ?? outcome.Failure ?? "no_result"))));
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
            var first = _approvalLink is null;
            _approvalLink = TrayView.OpenableUrl(approval.Link);
            // The tray opens the page itself, outside the job (ConnectCommand): once, when the code arrives.
            if (first && _approvalLink is { } link)
                _host.OpenInBrowser(link);
            ApprovalText.Text = T.Format("settings.approve", ("code", approval.UserCode));
            ApprovalCode.Text = approval.UserCode;
            OpenApproval.IsEnabled = _approvalLink is not null;
            ApprovalBox.Visibility = Visibility.Visible;
            AdiutorSection.IsExpanded = true;
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
}
