import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

// Auto-update wiring. Dormant unless the packaged build was produced with a
// publish provider configured (electron-builder writes app-update.yml then).
// Without a feed, electron-updater errors on the first check — we swallow that
// so it can never disrupt startup. See electron-builder.yml.
export function initUpdater(): void {
  if (!app.isPackaged) return; // dev/build runs have no update feed

  autoUpdater.autoDownload = true;
  autoUpdater.on('error', (err) => console.warn('[updater] error', err?.message ?? err));
  autoUpdater.on('update-available', (info) => console.log('[updater] update available', info.version));
  autoUpdater.on('update-downloaded', (info) => console.log('[updater] downloaded', info.version, '(applies on quit)'));

  // checkForUpdatesAndNotify resolves null (and emits 'error') when no feed is
  // configured; the handlers above keep that contained.
  autoUpdater.checkForUpdatesAndNotify().catch((e) => console.warn('[updater] check failed', e?.message ?? e));
}
