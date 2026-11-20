import { desktopCapturer, screen, systemPreferences } from 'electron';

/** macOS needs explicit Screen Recording permission; without it captures only show the wallpaper. */
export function screenPermission() {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.getMediaAccessStatus('screen') === 'granted';
}

export function accessibilityPermission() {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(false);
}

/**
 * Capture screenshots of the displays. Returns one JPEG per display:
 * [{ jpeg: Buffer, width, height }]
 */
export async function captureScreens({ maxWidth = 1600, quality = 55, blur = false, allScreens = true }) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  // Ask Chromium for thumbnails big enough for the largest display (capped at maxWidth).
  const biggest = displays.reduce((m, d) => Math.max(m, d.size.width * d.scaleFactor), 0);
  const w = Math.min(maxWidth, Math.round(biggest));
  const tallest = displays.reduce((m, d) => Math.max(m, (d.size.height / d.size.width) * w), 0);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: w, height: Math.round(tallest) },
  });
  let picked = sources;
  if (!allScreens) {
    const p = sources.find((s) => String(s.display_id) === String(primary.id));
    picked = [p || sources[0]].filter(Boolean);
  }
  const out = [];
  for (const s of picked) {
    let img = s.thumbnail;
    if (!img || img.isEmpty()) continue;
    if (blur) {
      // Cheap privacy blur: shrink hard, then scale back up (text becomes unreadable).
      const { width, height } = img.getSize();
      img = img.resize({ width: Math.max(16, Math.round(width / 14)), quality: 'good' })
        .resize({ width, height, quality: 'good' });
    }
    const { width, height } = img.getSize();
    out.push({ jpeg: img.toJPEG(Math.max(10, Math.min(95, quality))), width, height });
  }
  return out;
}
