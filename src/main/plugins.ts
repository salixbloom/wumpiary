import { app, BrowserWindow, WebContentsView, Notification, clipboard, dialog, globalShortcut, net, protocol, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { IPC } from '../shared/ipc';
import { PluginManifestSchema } from '../shared/schemas';
import { ALL_PERMISSIONS, PluginInfo, PluginManifest, PluginMetadata, PluginPermission } from '../shared/plugins';

// Owns plugin discovery, the permission model, plugin storage, the sandboxed
// headless host window, plugin UI surfaces (standalone windows + interior
// panels), the Discord-view content scripts, and the validated bridge between
// every plugin context and the rest of the app.
//
// Trust model: plugin JS always runs sandboxed with no Node. The headless host
// is CSP-locked with no network; UI surfaces load the plugin's own files from a
// per-plugin origin (wumpiary-plugin://<id>/) and only reach the network if the
// plugin was granted `network`. EVERY outbound effect a plugin asks for is
// RE-CHECKED here against its granted permissions before it happens, and the
// plugin id behind a UI call is derived from the sender, never trusted from the
// message. This is the real boundary; the per-context gating is convenience.

interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
  code: string | null; // entry script source (null if no entry / unreadable)
  contentScript: string | null; // content-script source (null if none / unreadable)
  hasReadme: boolean; // a README.md exists in the folder (drives the help button)
  error: string | null;
}

interface PermsFile {
  [pluginId: string]: {
    enabled: boolean;
    permissions: Partial<Record<PluginPermission, 'granted' | 'denied'>>;
  };
}

// Fire-and-forget methods (ipc PH_CALL) → required permission (or '' if always allowed).
const CALL_PERM: Record<string, PluginPermission | ''> = {
  log: '', storageSet: '', storageDelete: '', broadcast: '',
  'window.open': '', 'window.close': '',
  notify: 'notifications',
  setDiscordCss: 'discord-css',
  'hotkeys.unregister': 'hotkeys',
};
// Request/response methods (ipc PH_INVOKE) → required permission.
const INVOKE_PERM: Record<string, PluginPermission | ''> = {
  storageGet: '', storageAll: '',
  getAccounts: 'accounts',
  http: 'network',
  'files.save': 'files', 'files.open': 'files',
  'clipboard.writeText': 'clipboard', 'clipboard.readText': 'clipboard',
  'hotkeys.register': 'hotkeys',
};

const MAX_HTTP_BYTES = 250 * 1024 * 1024;
const MAX_FILE_BYTES = 250 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export interface PluginDeps {
  onDiscordCss: (combinedCss: string) => void;
  onChange: () => void;
  getAccounts: () => unknown[];
  /** Run a content-script delivery in account views (broadcast/events). */
  dispatchToContent: (pluginId: string, msg: unknown, exceptAccountId?: string) => void;
  /** Re-evaluate which content scripts should be injected into Discord views. */
  reinjectContent: () => void;
}

export class PluginManager {
  private dir = path.join(app.getPath('userData'), 'plugins');
  private dataDir = path.join(app.getPath('userData'), 'plugin-data');
  private permsPath = path.join(this.dir, 'permissions.json');

  private discovered = new Map<string, DiscoveredPlugin>();
  private perms: PermsFile = {};
  private discordCss = new Map<string, string>();

  private host: BrowserWindow | null = null;
  private hostReady = false;

  // UI surfaces, keyed by plugin id.
  private windows = new Map<string, BrowserWindow>();
  private panels = new Map<string, WebContentsView>();
  // webContents id -> the plugin context behind it (for authoritative id resolution).
  private uiCtx = new Map<number, { pluginId: string; kind: 'window' | 'panel' }>();
  // pluginId -> registered global-shortcut accelerators (for cleanup).
  private hotkeys = new Map<string, Set<string>>();

  constructor(
    private hostPreloadPath: string,
    private uiPreloadPath: string,
    private getOwnerWindow: () => BrowserWindow | null,
    private deps: PluginDeps,
  ) {}

  // ---- discovery & permissions ------------------------------------------
  init() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch { /* ignore */ }
    this.registerProtocol();
    this.seedBundled();
    this.perms = this.readPerms();
    this.discover();
  }

  /** Serve each plugin's own UI files from wumpiary-plugin://<id>/<path>. */
  private registerProtocol() {
    try {
      protocol.handle('wumpiary-plugin', (request) => {
        const url = new URL(request.url);
        const id = url.hostname;
        const d = this.discovered.get(id);
        // Only serve files for an enabled plugin (defence in depth).
        if (!d || !this.perms[id]?.enabled) return new Response(null, { status: 404 });
        const rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html';
        const target = path.resolve(d.dir, rel);
        if (target !== d.dir && !target.startsWith(d.dir + path.sep)) return new Response(null, { status: 403 });
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return new Response(null, { status: 404 });
        const net2 = net.fetch(pathToFileURL(target).toString());
        const csp = this.cspFor(id);
        const mime = MIME[path.extname(target).toLowerCase()];
        return net2.then((res) => {
          const headers = new Headers(res.headers);
          headers.set('Content-Security-Policy', csp);
          if (mime) headers.set('Content-Type', mime);
          return new Response(res.body, { status: res.status, headers });
        });
      });
    } catch (e) {
      console.error('[plugins] protocol register failed', e);
    }
  }

  private cspFor(id: string): string {
    const scripts = "wumpiary-plugin: 'unsafe-inline' 'unsafe-eval'";
    const netCsp = this.granted(id, 'network')
      ? "connect-src https: wss: blob: data:; img-src wumpiary-plugin: https: data: blob:; media-src wumpiary-plugin: https: data: blob:"
      : "connect-src 'none'; img-src wumpiary-plugin: data: blob:; media-src wumpiary-plugin: data: blob:";
    return `default-src 'none'; script-src ${scripts}; style-src wumpiary-plugin: 'unsafe-inline'; font-src wumpiary-plugin: data:; ${netCsp}`;
  }

  /** Copy plugins bundled with the app into userData. New plugins are copied
   *  whole. For ones already present we ADD missing files within a version, but
   *  on an app UPGRADE we overwrite the bundled files with the shipped copies so
   *  fixes to default plugins actually reach existing installs (otherwise a
   *  broken manifest/script seeded once would be frozen forever). User data
   *  (plugin-data/) and grants (permissions.json) live elsewhere and are never
   *  touched here; only the plugin's own code/manifest/assets get refreshed. */
  private seedBundled() {
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
    const src = path.join(base, 'resources', 'plugins');
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
    const stampPath = path.join(this.dir, '.bundled-version');
    const version = app.getVersion();
    let upgraded = false;
    try { upgraded = fs.readFileSync(stampPath, 'utf8').trim() !== version; } catch { upgraded = true; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const from = path.join(src, ent.name);
      const dest = path.join(this.dir, ent.name);
      try {
        if (!fs.existsSync(dest)) fs.cpSync(from, dest, { recursive: true });
        else if (upgraded) fs.cpSync(from, dest, { recursive: true, force: true });
        else this.copyMissing(from, dest);
      } catch (e) { console.error('[plugins] seed failed', ent.name, e); }
    }
    try { fs.writeFileSync(stampPath, version); } catch (e) { console.error('[plugins] seed stamp failed', e); }
  }

  /** Recursively copy only files that don't already exist in dest. */
  private copyMissing(from: string, dest: string) {
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, ent.name);
      const d = path.join(dest, ent.name);
      if (ent.isDirectory()) { fs.mkdirSync(d, { recursive: true }); this.copyMissing(s, d); }
      else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
    }
  }

  private readPerms(): PermsFile {
    try { return JSON.parse(fs.readFileSync(this.permsPath, 'utf8')) as PermsFile; } catch { return {}; }
  }

  private writePerms() {
    try { fs.writeFileSync(this.permsPath, JSON.stringify(this.perms, null, 2)); } catch (e) { console.error('[plugins] perms write failed', e); }
  }

  private readFileInside(dir: string, rel: string | undefined): { code: string | null; error: string | null } {
    if (!rel) return { code: null, error: null };
    const p = path.resolve(dir, rel);
    if (p !== dir && !p.startsWith(dir + path.sep)) return { code: null, error: `"${rel}" escapes the plugin folder` };
    try { return { code: fs.readFileSync(p, 'utf8'), error: null }; } catch { return { code: null, error: `file not found: ${rel}` }; }
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
        const hasReadme = fs.existsSync(path.join(pdir, 'README.md'));
        if (!parsed.success) {
          this.discovered.set(ent.name, { manifest: { id: ent.name } as PluginManifest, dir: pdir, code: null, contentScript: null, hasReadme, error: `invalid manifest: ${parsed.error.issues.map((i) => i.message).join(', ')}` });
          continue;
        }
        const manifest = parsed.data as PluginManifest;
        if (manifest.id !== ent.name) {
          this.discovered.set(ent.name, { manifest, dir: pdir, code: null, contentScript: null, hasReadme, error: `manifest id "${manifest.id}" must match folder name "${ent.name}"` });
          continue;
        }
        const entry = this.readFileInside(pdir, manifest.entry);
        const content = this.readFileInside(pdir, manifest.contentScript);
        const error = entry.error || content.error;
        this.discovered.set(manifest.id, { manifest, dir: pdir, code: entry.code, contentScript: content.code, hasReadme, error });

        // Record newly-requested permissions as "denied" so the user can see and grant them.
        const rec = this.perms[manifest.id] || (this.perms[manifest.id] = { enabled: false, permissions: {} });
        for (const p of manifest.permissions) {
          if (rec.permissions[p] === undefined) rec.permissions[p] = 'denied';
        }
      } catch {
        this.discovered.set(ent.name, { manifest: { id: ent.name } as PluginManifest, dir: pdir, code: null, contentScript: null, hasReadme: fs.existsSync(path.join(pdir, 'README.md')), error: 'missing or unreadable manifest.json' });
      }
    }
    this.writePerms();
  }

  private granted(id: string, perm: PluginPermission): boolean {
    return this.perms[id]?.permissions[perm] === 'granted';
  }

  private isEnabled(id: string): boolean {
    const d = this.discovered.get(id);
    return !!d && !d.error && this.perms[id]?.enabled === true;
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
        metadata: (d.manifest.metadata ?? {}) as PluginMetadata,
        ui: {
          hasPanel: !!d.manifest.ui?.panel,
          panelTitle: d.manifest.ui?.panel?.title,
          hasWindow: !!d.manifest.ui?.window,
          windowTitle: d.manifest.ui?.window?.title,
          hasReadme: d.hasReadme,
        },
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

  // ---- headless host window ----------------------------------------------
  startHost() {
    if (this.host) { this.reloadHost(); return; }
    this.host = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: this.hostPreloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.host.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.warn('[plugin-host]', msg); });
    const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-eval' 'unsafe-inline'; connect-src 'none'"><title>wumpiary plugin host</title>`;
    this.hostReady = false;
    this.host.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch((e) => console.error('[plugins] host load failed', e));
    this.host.on('closed', () => { this.host = null; this.hostReady = false; });
  }

  /** Headless plugins = enabled plugins that ship an entry script. */
  private sendLoad() {
    if (!this.host || this.host.isDestroyed()) return;
    const payload = [...this.discovered.values()]
      .filter((d) => this.isEnabled(d.manifest.id) && d.code)
      .map((d) => ({
        id: d.manifest.id,
        code: d.code as string,
        perms: (d.manifest.permissions ?? []).filter((p) => this.granted(d.manifest.id, p)),
        storage: this.readStorage(d.manifest.id),
      }));
    this.host.webContents.send(IPC.phMsg, { t: 'load', plugins: payload });
    this.recomputeCss();
  }

  private reloadHost() {
    if (this.host && this.hostReady) this.sendLoad();
    // UI surfaces and content scripts must reflect new enabled/permission state too.
    this.refreshUiPerms();
    this.deps.reinjectContent();
  }

  isHostSender(sender: Electron.WebContents): boolean {
    return !!this.host && !this.host.isDestroyed() && sender === this.host.webContents;
  }

  // ---- sender → plugin id resolution ------------------------------------
  /** Resolve the authoritative plugin id behind an IPC sender. For the shared
   *  host, trust the message's id (one context, many plugins). For a UI surface,
   *  derive it from the sender and ignore whatever the message claims. */
  private resolvePlugin(sender: Electron.WebContents, claimed: string | undefined): string | null {
    if (this.isHostSender(sender)) return claimed && this.isEnabled(claimed) ? claimed : null;
    const ctx = this.uiCtx.get(sender.id);
    if (ctx && this.isEnabled(ctx.pluginId)) return ctx.pluginId;
    return null;
  }

  // ---- fire-and-forget calls (PH_CALL) ----------------------------------
  handleHostCall(sender: Electron.WebContents, raw: unknown) {
    const m = raw as { t: string; pluginId?: string; method?: string; args?: unknown[]; message?: string };
    if (m.t === 'ready') { if (this.isHostSender(sender)) { this.hostReady = true; this.sendLoad(); } return; }
    if (m.t === 'error') {
      const id = this.resolvePlugin(sender, m.pluginId);
      if (id) { const d = this.discovered.get(id); if (d) { d.error = `runtime error: ${m.message}`; this.deps.onChange(); } }
      return;
    }
    if (m.t !== 'call' || !m.method) return;
    const id = this.resolvePlugin(sender, m.pluginId);
    if (!id) return;
    const need = CALL_PERM[m.method];
    if (need === undefined) return; // unknown method
    if (need && !this.granted(id, need)) return;

    const args = m.args ?? [];
    switch (m.method) {
      case 'log':
        console.log(`[plugin:${id}]`, ...(args as unknown[]).map(String));
        break;
      case 'storageSet': { const [k, v] = args as [string, unknown]; const data = this.readStorage(id); data[k] = v; this.writeStorage(id, data); break; }
      case 'storageDelete': { const [k] = args as [string]; const data = this.readStorage(id); delete data[k]; this.writeStorage(id, data); break; }
      case 'broadcast': { const [channel, data] = args as [string, unknown]; this.deliverBroadcast(id, String(channel), data, sender.id); break; }
      case 'notify': {
        const o = (args[0] ?? {}) as { title?: string; body?: string };
        try { new Notification({ title: String(o.title ?? '').slice(0, 200), body: String(o.body ?? '').slice(0, 1000) }).show(); } catch { /* ignore */ }
        break;
      }
      case 'setDiscordCss': { this.discordCss.set(id, String(args[0] ?? '')); this.recomputeCss(); break; }
      case 'window.open': this.openWindow(id); break;
      case 'window.close': this.closeWindow(id); break;
      case 'hotkeys.unregister': this.unregisterHotkey(id, String(args[0] ?? '')); break;
    }
  }

  // ---- request/response calls (PH_INVOKE) -------------------------------
  async handleHostInvoke(sender: Electron.WebContents, raw: unknown): Promise<unknown> {
    const m = raw as { pluginId?: string; method?: string; args?: unknown[] };
    if (!m.method) return { error: 'bad-request' };
    const id = this.resolvePlugin(sender, m.pluginId);
    if (!id) return { error: 'not-allowed' };
    const need = INVOKE_PERM[m.method];
    if (need === undefined) return { error: 'unknown-method' };
    if (need && !this.granted(id, need)) return { error: 'permission-denied' };

    const args = m.args ?? [];
    try {
      switch (m.method) {
        case 'storageGet': return this.readStorage(id)[args[0] as string];
        case 'storageAll': return this.readStorage(id);
        case 'getAccounts': return this.deps.getAccounts();
        case 'http': return await this.doHttp(args[0]);
        case 'files.save': return await this.doFileSave(args[0]);
        case 'files.open': return await this.doFileOpen(args[0]);
        case 'clipboard.writeText': clipboard.writeText(String(args[0] ?? '')); return { ok: true };
        case 'clipboard.readText': return clipboard.readText();
        case 'hotkeys.register': return this.registerHotkey(id, String(args[0] ?? ''));
      }
    } catch (e) {
      return { error: String((e as { message?: string })?.message ?? e) };
    }
    return { error: 'unknown-method' };
  }

  private async doHttp(req: unknown): Promise<unknown> {
    const r = (req ?? {}) as { url?: string; method?: string; headers?: Record<string, string>; body?: string | Uint8Array };
    const url = String(r.url ?? '');
    if (!/^https?:\/\//i.test(url)) return { error: 'only http(s) urls allowed' };
    const res = await net.fetch(url, {
      method: r.method || 'GET',
      headers: r.headers || {},
      body: r.body as BodyInit | undefined,
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_HTTP_BYTES) return { error: 'response too large' };
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { ok: res.ok, status: res.status, headers, contentType: res.headers.get('content-type') || '', body: buf };
  }

  private async doFileSave(arg: unknown): Promise<unknown> {
    const o = (arg ?? {}) as { suggestedName?: string; data?: Uint8Array | string; filters?: { name: string; extensions: string[] }[] };
    const win = this.getOwnerWindow();
    const opts = { defaultPath: o.suggestedName ? path.basename(o.suggestedName) : undefined, filters: o.filters };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    const data = o.data instanceof Uint8Array ? Buffer.from(o.data) : Buffer.from(String(o.data ?? ''), 'base64');
    await fs.promises.writeFile(res.filePath, data);
    return { ok: true, path: res.filePath };
  }

  private async doFileOpen(arg: unknown): Promise<unknown> {
    const o = (arg ?? {}) as { filters?: { name: string; extensions: string[] }[]; multiple?: boolean };
    const win = this.getOwnerWindow();
    const opts: Electron.OpenDialogOptions = { properties: o.multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters: o.filters };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const files: { name: string; size: number; data: Uint8Array }[] = [];
    for (const fp of res.filePaths) {
      const stat = await fs.promises.stat(fp);
      if (stat.size > MAX_FILE_BYTES) continue;
      const data = new Uint8Array(await fs.promises.readFile(fp));
      files.push({ name: path.basename(fp), size: stat.size, data });
    }
    return { ok: true, files };
  }

  private registerHotkey(id: string, accel: string): boolean {
    if (!accel) return false;
    try {
      const ok = globalShortcut.register(accel, () => this.deliverEvent(id, 'hotkey', { accelerator: accel }));
      if (ok) (this.hotkeys.get(id) || this.hotkeys.set(id, new Set()).get(id)!).add(accel);
      return ok;
    } catch { return false; }
  }

  private unregisterHotkey(id: string, accel: string) {
    const set = this.hotkeys.get(id);
    if (set?.has(accel)) { try { globalShortcut.unregister(accel); } catch { /* ignore */ } set.delete(accel); }
  }

  private clearHotkeys(id: string) {
    const set = this.hotkeys.get(id);
    if (!set) return;
    for (const a of set) { try { globalShortcut.unregister(a); } catch { /* ignore */ } }
    this.hotkeys.delete(id);
  }

  // ---- UI surfaces -------------------------------------------------------
  private uiArgs(id: string): string[] {
    const granted = ALL_PERMISSIONS.filter((p) => this.granted(id, p));
    return [`--plugin-id=${id}`, `--plugin-perms=${granted.join(',')}`];
  }

  openWindow(id: string) {
    const d = this.discovered.get(id);
    const win = d?.manifest.ui?.window;
    if (!d || !win || !this.isEnabled(id)) return;
    const existing = this.windows.get(id);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
    const w = new BrowserWindow({
      width: win.width ?? 480,
      height: win.height ?? 640,
      frame: win.frame ?? false,
      title: win.title ?? d.manifest.name,
      backgroundColor: '#1e1f22',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.uiPreloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        additionalArguments: this.uiArgs(id),
      },
    });
    this.windows.set(id, w);
    this.uiCtx.set(w.webContents.id, { pluginId: id, kind: 'window' });
    w.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.warn(`[plugin-win:${id}]`, msg); });
    w.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('http')) shell.openExternal(url); return { action: 'deny' }; });
    w.on('closed', () => { this.uiCtx.delete(w.webContents.id); this.windows.delete(id); });
    w.once('ready-to-show', () => w.show());
    w.loadURL(`wumpiary-plugin://${id}/${win.entry}`).catch((e) => console.error('[plugins] window load failed', id, e));
  }

  private closeWindow(id: string) {
    const w = this.windows.get(id);
    if (w && !w.isDestroyed()) w.close();
  }

  // The config panel is a WebContentsView whose position is driven entirely by
  // the renderer (a config subpage inside Settings → Plugins). The renderer
  // mounts it (openPanel), keeps it aligned to a placeholder (setPanelBounds),
  // and unmounts it (closePanel) on Back / tab change / settings close — so it
  // can never outlive its subpage and trap the UI behind a floating native view.
  openPanel(id: string) {
    const d = this.discovered.get(id);
    const panel = d?.manifest.ui?.panel;
    const owner = this.getOwnerWindow();
    if (!d || !panel || !this.isEnabled(id) || !owner) return;
    if (this.panels.has(id)) return;
    const view = new WebContentsView({
      webPreferences: {
        preload: this.uiPreloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        additionalArguments: this.uiArgs(id),
      },
    });
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); // hidden until the renderer sends bounds
    this.panels.set(id, view);
    this.uiCtx.set(view.webContents.id, { pluginId: id, kind: 'panel' });
    view.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.warn(`[plugin-panel:${id}]`, msg); });
    owner.contentView.addChildView(view);
    view.webContents.loadURL(`wumpiary-plugin://${id}/${panel.entry}`).catch((e) => console.error('[plugins] panel load failed', id, e));
  }

  setPanelBounds(id: string, x: number, y: number, width: number, height: number) {
    const view = this.panels.get(id);
    if (!view || view.webContents.isDestroyed()) return;
    view.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)) });
  }

  closePanel(id: string) {
    const view = this.panels.get(id);
    const owner = this.getOwnerWindow();
    if (!view) return;
    if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view);
    this.uiCtx.delete(view.webContents.id);
    try { view.webContents.close(); } catch { /* ignore */ }
    this.panels.delete(id);
  }

  /** A plugin's README.md, for the help subpage. */
  getReadme(id: string): string | null {
    const d = this.discovered.get(id);
    if (!d || !d.hasReadme) return null;
    try { return fs.readFileSync(path.join(d.dir, 'README.md'), 'utf8').slice(0, 200_000); } catch { return null; }
  }

  /** Tear down UI contexts whose plugin got disabled or lost a needed permission. */
  private refreshUiPerms() {
    for (const id of [...this.windows.keys()]) if (!this.isEnabled(id)) this.closeWindow(id);
    for (const id of [...this.panels.keys()]) if (!this.isEnabled(id)) this.closePanel(id);
  }

  // ---- broadcast / events to plugin contexts ----------------------------
  private uiContextsFor(id: string): Electron.WebContents[] {
    const out: Electron.WebContents[] = [];
    const w = this.windows.get(id); if (w && !w.isDestroyed()) out.push(w.webContents);
    const p = this.panels.get(id); if (p && !p.webContents.isDestroyed()) out.push(p.webContents);
    return out;
  }

  /** Deliver a named event to a single plugin's host + UI contexts. */
  private deliverEvent(id: string, name: string, payload: unknown) {
    if (this.host && this.hostReady) this.host.webContents.send(IPC.phMsg, { t: 'event', name, payload, targets: [id] });
    for (const wc of this.uiContextsFor(id)) wc.send(IPC.phMsg, { t: 'event', name, payload });
  }

  /** Fan a broadcast out to every context of the plugin except the originator. */
  private deliverBroadcast(id: string, channel: string, data: unknown, exceptWcId?: number, exceptAccountId?: string) {
    if (this.host && this.hostReady && this.host.webContents.id !== exceptWcId) {
      this.host.webContents.send(IPC.phMsg, { t: 'broadcast', pluginId: id, channel, data });
    }
    for (const wc of this.uiContextsFor(id)) if (wc.id !== exceptWcId) wc.send(IPC.phMsg, { t: 'broadcast', channel, data });
    this.deps.dispatchToContent(id, { t: 'broadcast', channel, data }, exceptAccountId);
  }

  /** Content script (Discord view) broadcasting to the plugin's other contexts. */
  handleContentMsg(p: { accountId: string; pluginId: string; channel: string; data: unknown }) {
    if (!this.isEnabled(p.pluginId) || !this.granted(p.pluginId, 'discord-view')) return;
    this.deliverBroadcast(p.pluginId, String(p.channel), p.data, undefined, p.accountId);
  }

  /** Content scripts to inject into each Discord view (enabled + discord-view granted). */
  getContentScripts(): { pluginId: string; code: string }[] {
    return [...this.discovered.values()]
      .filter((d) => this.isEnabled(d.manifest.id) && d.contentScript && this.granted(d.manifest.id, 'discord-view'))
      .map((d) => ({ pluginId: d.manifest.id, code: d.contentScript as string }));
  }

  private recomputeCss() {
    const parts: string[] = [];
    for (const [id, css] of this.discordCss) {
      if (this.isEnabled(id) && this.granted(id, 'discord-css') && css) parts.push(`/* plugin: ${id} */\n${css}`);
    }
    this.deps.onDiscordCss(parts.join('\n\n'));
  }

  private targetsFor(perm: PluginPermission): string[] {
    return [...this.discovered.values()].filter((d) => this.isEnabled(d.manifest.id) && this.granted(d.manifest.id, perm) && d.code).map((d) => d.manifest.id);
  }

  emitNotification(payload: unknown) {
    if (!this.host || !this.hostReady) return;
    const targets = this.targetsFor('notifications');
    if (targets.length) this.host.webContents.send(IPC.phMsg, { t: 'event', name: 'notification', payload, targets });
    // also deliver to notification-granted plugins' UI contexts
    for (const id of new Set([...this.windows.keys(), ...this.panels.keys()])) {
      if (this.isEnabled(id) && this.granted(id, 'notifications')) for (const wc of this.uiContextsFor(id)) wc.send(IPC.phMsg, { t: 'event', name: 'notification', payload });
    }
  }

  emitAccounts(snapshot: unknown[]) {
    if (this.host && this.hostReady) {
      const targets = this.targetsFor('accounts');
      if (targets.length) this.host.webContents.send(IPC.phMsg, { t: 'accounts', snapshot, targets });
    }
    for (const id of new Set([...this.windows.keys(), ...this.panels.keys()])) {
      if (this.isEnabled(id) && this.granted(id, 'accounts')) for (const wc of this.uiContextsFor(id)) wc.send(IPC.phMsg, { t: 'accounts', snapshot });
    }
  }

  // ---- renderer-driven controls -----------------------------------------
  setEnabled(id: string, on: boolean) {
    if (!this.perms[id]) this.perms[id] = { enabled: false, permissions: {} };
    this.perms[id].enabled = on;
    if (!on) { this.discordCss.delete(id); this.clearHotkeys(id); }
    this.writePerms();
    this.reloadHost();
    this.recomputeCss();
    this.deps.onChange();
  }

  setPermission(id: string, perm: PluginPermission, granted: boolean) {
    if (!this.perms[id]) this.perms[id] = { enabled: false, permissions: {} };
    this.perms[id].permissions[perm] = granted ? 'granted' : 'denied';
    if (perm === 'discord-css' && !granted) this.discordCss.delete(id);
    if (perm === 'hotkeys' && !granted) this.clearHotkeys(id);
    this.writePerms();
    this.reloadHost();
    this.recomputeCss();
    this.deps.onChange();
  }

  reload() {
    for (const id of [...this.windows.keys()]) this.closeWindow(id);
    for (const id of [...this.panels.keys()]) this.closePanel(id);
    for (const id of [...this.hotkeys.keys()]) this.clearHotkeys(id);
    this.discover();
    this.discordCss.clear();
    if (this.host && this.hostReady) this.sendLoad();
    this.recomputeCss();
    this.deps.reinjectContent();
    this.deps.onChange();
  }

  openFolder() { shell.openPath(this.dir).catch(() => undefined); }

  destroy() {
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.destroy();
    this.windows.clear();
    this.panels.clear();
    for (const id of [...this.hotkeys.keys()]) this.clearHotkeys(id);
    if (this.host && !this.host.isDestroyed()) this.host.destroy();
    this.host = null;
  }
}
