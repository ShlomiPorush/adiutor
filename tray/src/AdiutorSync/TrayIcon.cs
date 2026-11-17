using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using AdiutorSync.Core;

namespace AdiutorSync;

/// <summary>
/// The icon in the notification area (.NET's NotifyIcon): one icon per state, made once and destroyed at the end; the
/// tooltip; a click opens the panel; Windows notifications through its balloon, which Windows shows as a notification.
/// </summary>
internal sealed partial class TrayIcon : IDisposable
{
    private readonly NotifyIcon _icon;
    private readonly Dictionary<IconState, Icon> _icons = [];
    private readonly List<IntPtr> _handles = [];
    private IconState? _shown;
    private string _tooltip = "";

    public TrayIcon(string tooltip)
    {
        var size = SystemInformation.SmallIconSize.Width;
        foreach (var state in Enum.GetValues<IconState>())
        {
            using var bitmap = IconPainter.Draw(state, size);
            var handle = bitmap.GetHicon();
            _handles.Add(handle);
            _icons[state] = Icon.FromHandle(handle);
        }
        _icon = new NotifyIcon { Icon = _icons[IconState.Synced], Text = tooltip, Visible = true };
        _icon.MouseClick += (_, e) =>
        {
            if (e.Button is MouseButtons.Left or MouseButtons.Right)
                Clicked?.Invoke();
        };
        _icon.BalloonTipClicked += (_, _) => Clicked?.Invoke();
    }

    public event Action? Clicked;

    public void Show(IconState state, string tooltip)
    {
        if (_shown != state)
        {
            _icon.Icon = _icons[state];
            _shown = state;
        }
        if (_tooltip != tooltip)
        {
            _icon.Text = tooltip;
            _tooltip = tooltip;
        }
    }

    public void Notify(string title, string body) => _icon.ShowBalloonTip(10_000, title, body, ToolTipIcon.None);

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
        foreach (var icon in _icons.Values)
            icon.Dispose();
        foreach (var handle in _handles)
            DestroyIcon(handle);
        _handles.Clear();
    }

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DestroyIcon(IntPtr handle);
}
