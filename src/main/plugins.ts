import { app, BrowserWindow, Notification } from 'electron';
import { shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from '../shared/ipc';
import { PluginManifestSchema } from '../shared/schemas';
import { ALL_PERMISSIONS, PluginInfo, PluginManifest, PluginPermission } from '../shared/plugins';

// Owns plugin discovery, the permission model, the sandboxed host window, and
// the validated bridge between plugins and the rest of the app.
//
// Trust model: plugin JS runs in a hidden, CSP-locked host window with no Node
// and no network (see src/preload/plugin-host.ts). Every outbound effect a
// plugin asks for is RE-CHECKED here against its granted permissions before it
// happens — the host-side gating is only convenience; this is the real boundary.

interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
  code: string | null;
  error: string | null;
}

// permissions.json: the single source of truth for what each plugin is allowed
// to do and whether it is enabled.
interface PermsFile {
  [pluginId: string]: {
    enabled: boolean;
    permissions: Partial<Record<PluginPermission, 'granted' | 'denied'>>;
  };
}

const GATED: Record<string, PluginPermission> = {
  notify: 'notifications',
  setDiscordCss: 'discord-css',
};

export class PluginManager {
  private dir = path.join(app.getPath('userData'), 'plugins');
  private dataDir = path.join(app.getPath('userData'), 'plugin-data');
  private permsPath = path.join(this.dir, 'permissions.json');

  private discovered = new Map<string, DiscoveredPlugin>();
  private perms: PermsFile = {};
  private discordCss = new Map<string, string>(); // pluginId -> css (only while enabled+granted)

  private host: BrowserWindow | null = null;
  private hostReady = false;

  constructor(
    private preloadPath: string,
    private onDiscordCss: (combinedCss: string) => void,
    private onChange: () => void, // ask the controller to push fresh state
  ) {}

  // ---- discovery & permissions ------------------------------------------
  init() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch { /* ignore */ }
    this.perms = this.readPerms();
    this.discover();
  }

  private readPerms(): PermsFile {
    try { return JSON.parse(fs.readFileSync(this.permsPath, 'utf8')) as PermsFile; } catch { return {}; }
  }

  private writePerms() {
    try { fs.writeFileSync(this.permsPath, JSON.stringify(this.perms, null, 2)); } catch (e) { console.error('[plugins] perms write failed', e); }
  }

  private discover() {
    this.discovered.clear();
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { entries = []; }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const pdir = path.join(this.dir, ent.name);
      const manifestPath = path.join(pdir, 'manifest.json');
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const parsed = PluginManifestSchema.safeParse(raw);
        if (!parsed.success) {
          this.discovered.set(ent.name, { manifest: { id: ent.name } as PluginManifest, dir: pdir, code: null, error: `invalid manifest: ${parsed.error.issues.map((i) => i.message).join(', ')}` });
          continue;
        }
        const manifest = parsed.data as PluginManifest;
        if (manifest.id !== ent.name) {
          this.discovered.set(ent.name, { manifest, dir: pdir, code: null, error: `manifest id "${manifest.id}" must match folder name "${ent.name}"` });
          continue;
        }
        // entry must stay inside the plugin folder
        const entryPath = path.resolve(pdir, manifest.entry);
        if (!entryPath.startsWith(pdir + path.sep)) {
          this.discovered.set(manifest.id, { manifest, dir: pdir, code: null, error: 'entry escapes the plugin folder' });
          continue;
        }
        let code: string | null = null;
        let error: string | null = null;
        try { code = fs.readFileSync(entryPath, 'utf8'); } catch { error = `entry not found: ${manifest.entry}`; }
        this.discovered.set(manifest.id, { manifest, dir: pdir, code, error });

        // Record any newly-requested sensitive permissions into permissions.json
        // as "denied" so they are visible and the user can grant them. Existing
        // decisions are preserved.
        const rec = this.perms[manifest.id] || (this.perms[manifest.id] = { enabled: false, permissions: {} });
        for (const p of manifest.permissions) {
          if (rec.permissions[p] === undefined) rec.permissions[p] = 'denied';
        }
      } catch {
        this.discovered.set(ent.name, { manifest: { id: ent.name } as PluginManifest, dir: pdir, code: null, error: 'missing or unreadable manifest.json' });
      }
    }
    this.writePerms();
  }

  private granted(id: string, perm: PluginPermission): boolean {
    return this.perms[id]?.permissions[perm] === 'granted';
  }

  private isEnabled(id: string): boolean {
    const d = this.discovered.get(id);
    return !!d && !d.error && !!d.code && this.perms[id]?.enabled === true;
  }

  getInfos(): PluginInfo[] {
    return [...this.discovered.values()].map((d) => {
      const rec = this.perms[d.manifest.id];
      const requested = d.manifest.permissions ?? [];
      return {
        id: d.manifest.id,
        name: d.manifest.name ?? d.manifest.id,
        version: d.manifest.version ?? '',
        description: d.manifest.description ?? '',
        author: d.manifest.author ?? '',
        enabled: !!rec?.enabled,
        error: d.error,
        permissions: ALL_PERMISSIONS.filter((p) => requested.includes(p)).map((p) => ({ name: p, granted: rec?.permissions[p] === 'granted' })),
      };
    });
  }

  // ---- plugin-scoped storage --------------------------------------------
  private storagePath(id: string) { return path.join(this.dataDir, `${id}.json`); }
  private readStorage(id: string): Record<string, unknown> {
    try { return JSON.parse(fs.readFileSync(this.storagePath(id), 'utf8')); } catch { return {}; }
  }
  private writeStorage(id: string, data: Record<string, unknown>) {
    try { fs.writeFileSync(this.storagePath(id), JSON.stringify(data)); } catch (e) { console.error('[plugins] storage write failed', id, e); }
  }

  // ---- host window -------------------------------------------------------
  startHost() {
    if (this.host) { this.reloadHost(); return; }
    this.host = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false, // plugin timers/events must keep firing while hidden
      },
    });
    this.host.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.warn('[plugin-host]', msg); });
    // Minimal CSP-locked page: no remote origins, no network (connect-src 'none'),
    // only local eval for the plugin runtime. Plugins thus cannot fetch/XHR/WS.
    const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-eval' 'unsafe-inline'; connect-src 'none'"><title>wumpiary plugin host</title>`;
    this.hostReady = false;
    this.host.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch((e) => console.error('[plugins] host load failed', e));
    this.host.on('closed', () => { this.host = null; this.hostReady = false; });
  }

  /** Called when the host runtime reports {t:'ready'}; (re)send the plugin set. */
  private sendLoad() {
    if (!this.host || this.host.isDestroyed()) return;
    const payload = [...this.discovered.values()]
      .filter((d) => this.isEnabled(d.manifest.id))
      .map((d) => ({
        id: d.manifest.id,
        code: d.code as string,
        perms: (d.manifest.permissions ?? []).filter((p) => this.granted(d.manifest.id, p)),
        storage: this.readStorage(d.manifest.id),
      }));
    this.host.webContents.send(IPC.phMsg, { t: 'load', plugins: payload });
    // recompute discord css from currently-enabled+granted plugins
    this.recomputeCss();
  }

  private reloadHost() {
    if (this.host && this.hostReady) this.sendLoad();
  }

  /** Guard: only accept host-call IPC from our own hidden host window. */
  isHostSender(sender: Electron.WebContents): boolean {
    return !!this.host && !this.host.isDestroyed() && sender === this.host.webContents;
  }

  /** Handle messages coming back from the host (IPC.phCall). */
  handleHostCall(raw: unknown) {
    const m = raw as { t: string; pluginId?: string; method?: string; args?: unknown[]; message?: string };
    if (m.t === 'ready') { this.hostReady = true; this.sendLoad(); return; }
    if (m.t === 'error' && m.pluginId) {
      const d = this.discovered.get(m.pluginId);
      if (d) { d.error = `runtime error: ${m.message}`; this.onChange(); }
      return;
    }
    if (m.t !== 'call' || !m.pluginId || !m.method) return;
    const id = m.pluginId;
    if (!this.isEnabled(id)) return; // disabled plugins get nothing honored

    // Gate sensitive methods on the granted permission (real security boundary).
    const need = GATED[m.method];
    if (need && !this.granted(id, need)) return;

    const args = m.args ?? [];
    switch (m.method) {
      case 'log':
        console.log(`[plugin:${id}]`, ...(args as unknown[]).map(String));
        break;
      case 'storageSet': {
        const [k, v] = args as [string, unknown];
        const data = this.readStorage(id); data[k] = v; this.writeStorage(id, data);
        break;
      }
      case 'storageDelete': {
        const [k] = args as [string];
        const data = this.readStorage(id); delete data[k]; this.writeStorage(id, data);
        break;
      }
      case 'notify': {
        const o = (args[0] ?? {}) as { title?: string; body?: string };
        try { new Notification({ title: String(o.title ?? '').slice(0, 200), body: String(o.body ?? '').slice(0, 1000) }).show(); } catch { /* ignore */ }
        break;
      }
      case 'setDiscordCss': {
        const css = String(args[0] ?? '');
        this.discordCss.set(id, css);
        this.recomputeCss();
        break;
      }
    }
  }

  private recomputeCss() {
    const parts: string[] = [];
    for (const [id, css] of this.discordCss) {
      if (this.isEnabled(id) && this.granted(id, 'discord-css') && css) {
        parts.push(`/* plugin: ${id} */\n${css}`);
      }
    }
    this.onDiscordCss(parts.join('\n\n'));
  }

  // ---- events to plugins -------------------------------------------------
  private targetsFor(perm: PluginPermission): string[] {
    return [...this.discovered.values()].filter((d) => this.isEnabled(d.manifest.id) && this.granted(d.manifest.id, perm)).map((d) => d.manifest.id);
  }

  emitNotification(payload: unknown) {
    if (!this.host || !this.hostReady) return;
    const targets = this.targetsFor('notifications');
    if (targets.length) this.host.webContents.send(IPC.phMsg, { t: 'event', name: 'notification', payload, targets });
  }

  emitAccounts(snapshot: unknown[]) {
    if (!this.host || !this.hostReady) return;
    const targets = this.targetsFor('accounts');
    if (targets.length) this.host.webContents.send(IPC.phMsg, { t: 'accounts', snapshot, targets });
  }

  // ---- renderer-driven controls -----------------------------------------
  setEnabled(id: string, on: boolean) {
    if (!this.perms[id]) this.perms[id] = { enabled: false, permissions: {} };
    this.perms[id].enabled = on;
    if (!on) this.discordCss.delete(id);
    this.writePerms();
    this.reloadHost();
    this.recomputeCss();
    this.onChange();
  }

  setPermission(id: string, perm: PluginPermission, granted: boolean) {
    if (!this.perms[id]) this.perms[id] = { enabled: false, permissions: {} };
    this.perms[id].permissions[perm] = granted ? 'granted' : 'denied';
    if (perm === 'discord-css' && !granted) this.discordCss.delete(id);
    this.writePerms();
    this.reloadHost();
    this.recomputeCss();
    this.onChange();
  }

  reload() {
    this.discover();
    this.discordCss.clear();
    this.reloadHost();
    this.recomputeCss();
    this.onChange();
  }

  openFolder() {
    shell.openPath(this.dir).catch(() => undefined);
  }

  destroy() {
    if (this.host && !this.host.isDestroyed()) this.host.destroy();
    this.host = null;
  }
}
