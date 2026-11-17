using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using AdiutorSync.Core;

namespace AdiutorSync;

/// <summary>
/// Draws the six icon states at run time: a disc in the web app's status colours (src/web/styles/ui.css, light theme
/// tokens, which read on a light and a dark taskbar) with a white mark. Drawn from scratch; no image files.
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
        using var pen = new Pen(Color.White, Math.Max(1.6f, s * 0.11f))
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
            LineJoin = LineJoin.Round,
        };
        PointF P(float x, float y) => new(x * s, y * s);
        switch (state)
        {
            case IconState.Synced:
                g.DrawLines(pen, [P(0.28f, 0.52f), P(0.44f, 0.67f), P(0.72f, 0.36f)]);
                break;
            case IconState.Syncing:
                // A circular arrow.
                g.DrawArc(pen, s * 0.28f, s * 0.28f, s * 0.44f, s * 0.44f, -40, 290);
                var end = P(0.5f + 0.22f * MathF.Cos(-40 * MathF.PI / 180), 0.5f + 0.22f * MathF.Sin(-40 * MathF.PI / 180));
                g.DrawLines(pen, [new PointF(end.X - s * 0.17f, end.Y - s * 0.01f), end, new PointF(end.X + s * 0.01f, end.Y - s * 0.17f)]);
                break;
            case IconState.Problem:
                g.DrawLine(pen, P(0.5f, 0.27f), P(0.5f, 0.55f));
                using (var dot = new SolidBrush(Color.White))
                {
                    var r = pen.Width * 0.7f;
                    var c = P(0.5f, 0.72f);
                    g.FillEllipse(dot, c.X - r, c.Y - r, 2 * r, 2 * r);
                }
                break;
            case IconState.Paused:
                g.DrawLine(pen, P(0.40f, 0.31f), P(0.40f, 0.69f));
                g.DrawLine(pen, P(0.60f, 0.31f), P(0.60f, 0.69f));
                break;
            case IconState.NotConnected:
                g.DrawLine(pen, P(0.34f, 0.34f), P(0.66f, 0.66f));
                g.DrawLine(pen, P(0.66f, 0.34f), P(0.34f, 0.66f));
                break;
            case IconState.UpdateReady:
                g.DrawLine(pen, P(0.5f, 0.26f), P(0.5f, 0.68f));
                g.DrawLines(pen, [P(0.33f, 0.52f), P(0.5f, 0.69f), P(0.67f, 0.52f)]);
                break;
        }
        return bitmap;
    }
}
