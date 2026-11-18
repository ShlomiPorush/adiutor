# Adiutor brand assets

The orbit mark: you at the centre, and the assistant on its path around you.
Source of truth: `src/web/public/favicon.svg` in the repository (24-unit grid, tile 32 units, radius 8, mark at 0.9).

## Colours

| Name  | Hex       | Use                                   |
|-------|-----------|---------------------------------------|
| Ink   | `#111814` | Tile and wordmark on light backgrounds |
| Paper | `#f2f5f3` | Tile and wordmark on dark backgrounds  |
| Night | `#0e1110` | Dark canvas (social images)           |
| Muted | `#5e6863` / `#97a29c` | Tagline, light / dark     |

Wordmark: "Adiutor" in Onest, weight 750, tracking -0.02em. Onest is under the SIL Open Font License 1.1 (`fonts/OFL.txt`).

## Files

The favicon is `src/web/public/favicon.svg` and the Windows icon is `tray/src/AdiutorSync/adiutor.ico`; they are not copied here.
The files below were rendered from the favicon's geometry; a change to the mark means rendering them again.

- `svg/`: `adiutor-mark.svg` (currentColor), `-ink`, `-white`; `adiutor-icon.svg` (dark tile), `-light`;
  lockups for light and dark backgrounds, with and without the tagline.
  The lockup SVGs embed the Onest font: they render in browsers, but design tools may need the font installed.
- `png/icon/`: app icon 16 to 1024 (180 = apple-touch, 192 and 512 = PWA), light tile, maskable 512.
- `png/mark/`: the mark alone, transparent, ink and white.
- `png/lockup/`: lockups at 64 px and 256 px height.
- `png/social/`: Telegram avatar (640, full bleed, cropped to a circle by Telegram),
  GitHub social preview (1280x640), Open Graph image (1200x630).

Keep clear space of at least half the tile around the icon and lockups. Do not recolour, rotate or outline the mark.
