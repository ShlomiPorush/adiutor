using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using AdiutorSync.Core;

namespace AdiutorSync;

/// <summary>
/// Draws the six icon states at run time: Adiutor's mark (src/web/shell/Shell.tsx's BrandIcon, the orbit) in white on a
/// disc in the web app's status colours (src/web/styles/ui.css, light theme tokens, which read on a light and a dark
/// taskbar). The colour tells the state; the tooltip and the panel say it in words. Drawn from scratch; no image files.
/// </summary>
internal static class IconPainter
{
    public static Color ColorOf(IconState state) => state switch
    {
        IconState.Synced => Color.FromArgb(0x12, 0x80, 0x3f),       // --ui-ok
        IconState.Syncing => Color.FromArgb(0x1f, 0x5f, 0xbf),      // --ui-info
        IconState.Problem => Color.FromArgb(0x9a, 0x62, 0x00),      // --ui-warn
        IconState.Paused => Color.FromArgb(0x5e, 0x68, 0x63),       // --ui-muted
        IconState.NotConnected => Color.FromArgb(0xc4, 0x2b, 0x1c), // --ui-fail
        IconState.UpdateReady => Color.FromArgb(0x1f, 0x5f, 0xbf),  // --ui-info
        _ => Color.Gray,
    };

    public static Bitmap Draw(IconState state, int size)
    {
        var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bitmap);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.Clear(Color.Transparent);
        float s = size;
        using (var fill = new SolidBrush(ColorOf(state)))
            g.FillEllipse(fill, s * 0.03f, s * 0.03f, s * 0.94f, s * 0.94f);

        // The mark on BrandIcon's 24-unit grid, centred: a dot of radius 3.2, an arc of radius 8 open at the top right
        // (from -15 degrees clockwise through 300), and a satellite of radius 2.2 at -45 degrees in the opening. Below 24
        // pixels the stroke is at least 1.5 pixels and the opening is wider, so the satellite stays apart from the arc.
        var u = s * 0.034f;
        var small = size < 24;
        var c = s / 2;
        using var white = new SolidBrush(Color.White);
        g.FillEllipse(white, c - 3.2f * u, c - 3.2f * u, 6.4f * u, 6.4f * u);
        using (var pen = new Pen(Color.White, Math.Max(2.2f * u, small ? 1.5f : 0f)) { StartCap = LineCap.Round, EndCap = LineCap.Round })
        {
            var widen = small ? 8f : 0f;
            g.DrawArc(pen, c - 8 * u, c - 8 * u, 16 * u, 16 * u, -15 + widen, 300 - 2 * widen);
        }
        float sx = c + 5.66f * u, sy = c - 5.66f * u;
        g.FillEllipse(white, sx - 2.2f * u, sy - 2.2f * u, 4.4f * u, 4.4f * u);
        return bitmap;
    }
}
