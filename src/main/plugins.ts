import { app, BrowserWindow, WebContentsView, Notification, dialog, globalShortcut, net, protocol, shell, webContents } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as dns from 'dns';
import { isIP } from 'net';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { IPC } from '../shared/ipc';
import { PluginManifestSchema } from '../shared/schemas';
import { ALL_PERMISSIONS, PluginInfo, PluginManifest, PluginMetadata, PluginPermission } from '../shared/plugins';

// Owns plugin discovery, the permission model, plugin storage, the sandboxed
// headless host window, plugin UI surfaces (standalone windows + interior
// panels), the Discord-view content scripts, and the validated bridge between
// every plugin context and the rest of the app.
//
// Trust model: plugin JS always runs sandboxed with no Node. Each enabled
// headless plugin gets its OWN hidden host window (CSP-locked, no network);
// UI surfaces load the plugin's own files from a per-plugin origin
// (wumpiary-plugin://<id>/) and only reach the network if the plugin was granted
// `network`. EVERY outbound effect a plugin asks for is RE-CHECKED here against
// its granted permissions before it happens, and the plugin id behind EVERY call
// — host or UI — is derived from the IPC sender, never trusted from the message.
// Because no two plugins share a context, one plugin can neither impersonate
// another (to borrow its permissions) nor read another's storage. This is the
// real boundary; the per-context gating is convenience.

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
  // Clipboard is fire-only — it triggers the OS copy/paste action on the focused
  // field and returns nothing, so a plugin can never read clipboard/selection
  // contents (no readText). Both are PH_CALL for that reason.
  'clipboard.copy': 'clipboard', 'clipboard.paste': 'clipboard',
  'hotkeys.unregister': 'hotkeys',
};
// Request/response methods (ipc PH_INVOKE) → required permission.
const INVOKE_PERM: Record<string, PluginPermission | ''> = {
  storageGet: '', storageAll: '',
  getAccounts: 'accounts',
  http: 'network',
  'files.save': 'files', 'files.open': 'files',
  'fs.read': 'filesystem', 'fs.write': 'filesystem', 'fs.delete': 'filesystem',
  'fs.list': 'filesystem', 'fs.stat': 'filesystem',
  'hotkeys.register': 'hotkeys',
};

const MAX_HTTP_BYTES = 250 * 1024 * 1024;
const MAX_FILE_BYTES = 250 * 1024 * 1024;
// Per-plugin caps to keep a misbehaving/malicious plugin from wedging the main
// process. Storage is bounded (quota is user-configurable, see
// deps.getStorageLimitBytes) so a plugin can't fill the disk; bridge calls are
// rate-limited so a tight loop can't flood main with IPC; concurrent outbound
// http is capped so a plugin can't open unbounded sockets.
const RATE_WINDOW_MS = 1000;
const RATE_MAX_CALLS = 200; // bridge messages per plugin per window
const MAX_HTTP_CONCURRENCY = 8;

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
  /** Forward raw keyboard input from a plugin window so global Push-to-Talk
   *  keeps working while that window holds focus (it otherwise eats the keys). */
  forwardInput: (input: Electron.Input) => void;
  /** User-configured per-plugin storage quota, in bytes. */
  getStorageLimitBytes: () => number;
}

export class PluginManager {
  private dir = path.join(app.getPath('userData'), 'plugins');
  private dataDir = path.join(app.getPath('userData'), 'plugin-data');
  // Contained per-plugin file folders for the `filesystem` permission.
  private fsDir = path.join(app.getPath('userData'), 'plugin-fs');
  private permsPath = path.join(this.dir, 'permissions.json');

  private discovered = new Map<string, DiscoveredPlugin>();
  private perms: PermsFile = {};
  private discordCss = new Map<string, string>();

  // One hidden headless host PER plugin (keyed by plugin id), so the IPC sender
  // uniquely identifies the plugin behind every message.
  private hosts = new Map<string, { win: BrowserWindow; ready: boolean }>();
  private hostsStarted = false; // hosts only spin up after the user has unlocked

  // UI surfaces, keyed by plugin id.
  private windows = new Map<string, BrowserWindow>();
  private panels = new Map<string, WebContentsView>();
  // webContents id -> the plugin context behind it (for authoritative id resolution).
  private uiCtx = new Map<number, { pluginId: string; kind: 'host' | 'window' | 'panel' }>();
  // pluginId -> registered global-shortcut accelerators (for cleanup).
  private hotkeys = new Map<string, Set<string>>();

  // ---- per-plugin resource accounting -----------------------------------
  // In-memory storage cache (debounced to disk), with a dirty set + flush timer.
  private storageCache = new Map<string, Record<string, unknown>>();
  private storageDirty = new Set<string>();
  private storageTimer: NodeJS.Timeout | null = null;
  // Sliding-window IPC rate limiter, keyed by webContents id (one context = one plugin).
  private rate = new Map<number, { count: number; resetAt: number }>();
  // In-flight outbound http requests per plugin.
  private httpInflight = new Map<string, number>();
  // Cached byte usage of each plugin's contained `filesystem` folder (scanned
  // lazily once, then kept current on every write/delete).
  private fsUsage = new Map<string, number>();
  // Per-plugin secret tag authenticating content-script broadcasts (relayKey ->
  // pluginId and the reverse). A content script proves which plugin it is by
  // echoing the key main injected into its isolated world; it cannot read
  // another plugin's key out of its own world's scope, so it cannot broadcast as
  // another plugin. (Residual: a second, separately-malicious discord-view
  // plugin could observe the shared postMessage bus to learn the key — narrow,
  // and far weaker than the old "claim any id" path.)
  private contentKey = new Map<string, string>(); // pluginId -> relayKey
  private keyOwner = new Map<string, string>(); // relayKey -> pluginId

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
    try { fs.mkdirSync(this.fsDir, { recursive: true }); } catch { /* ignore */ }
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
  // Backed by an in-memory cache and flushed to disk on a short debounce, so a
  // plugin spamming storage.set() can't block the main thread on synchronous
  // writes. Total size per plugin is capped (MAX_STORAGE_BYTES) so it can't fill
  // the disk.
  private storagePath(id: string) { return path.join(this.dataDir, `${id}.json`); }
  private readStorage(id: string): Record<string, unknown> {
    let data = this.storageCache.get(id);
    if (!data) {
      try { data = JSON.parse(fs.readFileSync(this.storagePath(id), 'utf8')) as Record<string, unknown>; } catch { data = {}; }
      this.storageCache.set(id, data);
    }
    return data;
  }
  /** Serialized byte size of a plugin's key/value storage. */
  private kvBytes(id: string): number {
    try { return Buffer.byteLength(JSON.stringify(this.readStorage(id))); } catch { return 0; }
  }

  /** Apply a mutation to a plugin's storage, enforcing the (user-configured)
   *  size cap. The cap is the plugin's TOTAL on-disk budget — key/value storage
   *  plus its contained `filesystem` folder — so the slider is one clear knob.
   *  Returns false (and rolls back) if the result would exceed it. */
  private mutateStorage(id: string, fn: (data: Record<string, unknown>) => void): boolean {
    const data = this.readStorage(id);
    const before = JSON.stringify(data);
    fn(data);
    try {
      if (Buffer.byteLength(JSON.stringify(data)) + this.fsUsed(id) > this.deps.getStorageLimitBytes()) {
        this.storageCache.set(id, JSON.parse(before)); // roll back
        console.warn('[plugins] storage quota exceeded, write dropped', id);
        return false;
      }
    } catch { /* circular/oversized — fall through to flush attempt */ }
    this.storageDirty.add(id);
    this.scheduleStorageFlush();
    return true;
  }
  private scheduleStorageFlush() {
    if (this.storageTimer) return;
    this.storageTimer = setTimeout(() => {
      this.storageTimer = null;
      for (const id of this.storageDirty) {
        const data = this.storageCache.get(id) ?? {};
        fs.promises.writeFile(this.storagePath(id), JSON.stringify(data)).catch((e) => console.error('[plugins] storage write failed', id, e));
      }
      this.storageDirty.clear();
    }, 250);
  }
  private flushStorageNow() {
    if (this.storageTimer) { clearTimeout(this.storageTimer); this.storageTimer = null; }
    for (const id of this.storageDirty) {
      try { fs.writeFileSync(this.storagePath(id), JSON.stringify(this.storageCache.get(id) ?? {})); } catch (e) { console.error('[plugins] storage flush failed', id, e); }
    }
    this.storageDirty.clear();
  }

  // ---- headless host windows (one per plugin) ----------------------------
  /** Called once the user unlocks. From here on the set of host windows is kept
   *  in sync with the set of enabled headless plugins. */
  startHost() {
    this.hostsStarted = true;
    this.syncHosts();
  }

  /** Headless plugins = enabled plugins that ship an entry script. Create a host
   *  for each, tear down hosts whose plugin was disabled/removed, and refresh the
   *  load of any already-running host (perms/storage may have changed). */
  private syncHosts() {
    if (!this.hostsStarted) return;
    const want = new Set(
      [...this.discovered.values()].filter((d) => this.isEnabled(d.manifest.id) && d.code).map((d) => d.manifest.id),
    );
    for (const id of [...this.hosts.keys()]) if (!want.has(id)) this.destroyHost(id);
    for (const id of want) {
      const h = this.hosts.get(id);
      if (!h) this.createHost(id);
      else if (h.ready) this.sendLoadTo(id); // refresh perms/storage in a live host
    }
    this.recomputeCss();
  }

  private createHost(id: string) {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: this.hostPreloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const h = { win, ready: false };
    this.hosts.set(id, h);
    this.uiCtx.set(win.webContents.id, { pluginId: id, kind: 'host' });
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.warn(`[plugin-host:${id}]`, msg); });
    const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-eval' 'unsafe-inline'; connect-src 'none'"><title>wumpiary plugin host</title>`;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch((e) => console.error('[plugins] host load failed', id, e));
    win.on('closed', () => { this.uiCtx.delete(win.webContents.id); this.hosts.delete(id); });
  }

  private destroyHost(id: string) {
    const h = this.hosts.get(id);
    if (!h) return;
    this.uiCtx.delete(h.win.webContents.id);
    this.rate.delete(h.win.webContents.id);
    this.httpInflight.delete(id);
    this.hosts.delete(id);
    if (!h.win.isDestroyed()) h.win.destroy();
  }

  private sendLoadTo(id: string) {
    const h = this.hosts.get(id);
    const d = this.discovered.get(id);
    if (!h || !h.ready || h.win.isDestroyed() || !d || !d.code) return;
    h.win.webContents.send(IPC.phMsg, {
      t: 'load',
      id,
      code: d.code,
      perms: (d.manifest.permissions ?? []).filter((p) => this.granted(id, p)),
      storage: this.readStorage(id),
    });
  }

  private reloadHost() {
    this.syncHosts();
    // UI surfaces and content scripts must reflect new enabled/permission state too.
    this.refreshUiPerms();
    this.deps.reinjectContent();
  }

  /** webContents of a plugin's ready host, or null. */
  private hostWcFor(id: string): Electron.WebContents | null {
    const h = this.hosts.get(id);
    return h && h.ready && !h.win.isDestroyed() ? h.win.webContents : null;
  }

  // ---- sender → plugin id resolution ------------------------------------
  /** Resolve the authoritative plugin id behind an IPC sender. Every plugin
   *  context — headless host, window, or panel — is a single-plugin context
   *  registered in uiCtx, so the id is derived from the sender and any id the
   *  message claims is ignored entirely. */
  private resolvePlugin(sender: Electron.WebContents): string | null {
    const ctx = this.uiCtx.get(sender.id);
    if (ctx && this.isEnabled(ctx.pluginId)) return ctx.pluginId;
    return null;
  }

  /** Sliding-window rate limit, keyed by the calling context's webContents id.
   *  Returns false once a plugin exceeds RATE_MAX_CALLS within RATE_WINDOW_MS. */
  private rateOk(sender: Electron.WebContents): boolean {
    const now = Date.now();
    const e = this.rate.get(sender.id);
    if (!e || now >= e.resetAt) { this.rate.set(sender.id, { count: 1, resetAt: now + RATE_WINDOW_MS }); return true; }
    if (e.count >= RATE_MAX_CALLS) return false;
    e.count += 1;
    return true;
  }

  // ---- fire-and-forget calls (PH_CALL) ----------------------------------
  handleHostCall(sender: Electron.WebContents, raw: unknown) {
    const m = raw as { t: string; method?: string; args?: unknown[]; message?: string };
    if (m.t === 'ready') {
      const ctx = this.uiCtx.get(sender.id);
      if (ctx && ctx.kind === 'host') { const h = this.hosts.get(ctx.pluginId); if (h) { h.ready = true; this.sendLoadTo(ctx.pluginId); } }
      return;
    }
    const id = this.resolvePlugin(sender);
    if (!id) return;
    if (m.t === 'error') {
      const d = this.discovered.get(id); if (d) { d.error = `runtime error: ${m.message}`; this.deps.onChange(); }
      return;
    }
    if (m.t !== 'call' || !m.method) return;
    if (!this.rateOk(sender)) return;
    const need = CALL_PERM[m.method];
    if (need === undefined) return; // unknown method
    if (need && !this.granted(id, need)) return;

    const args = m.args ?? [];
    switch (m.method) {
      case 'log':
        console.log(`[plugin:${id}]`, ...(args as unknown[]).map(String));
        break;
      case 'storageSet': { const [k, v] = args as [string, unknown]; this.mutateStorage(id, (data) => { data[String(k)] = v; }); break; }
      case 'storageDelete': { const [k] = args as [string]; this.mutateStorage(id, (data) => { delete data[String(k)]; }); break; }
      case 'broadcast': { const [channel, data] = args as [string, unknown]; this.deliverBroadcast(id, String(channel), data, sender.id); break; }
      case 'notify': this.doNotify(id, args[0]); break;
      case 'setDiscordCss': { this.discordCss.set(id, String(args[0] ?? '')); this.recomputeCss(); break; }
      case 'clipboard.copy': this.fireClipboard('copy'); break;
      case 'clipboard.paste': this.fireClipboard('paste'); break;
      case 'window.open': this.openWindow(id); break;
      case 'window.close': this.closeWindow(id); break;
      case 'hotkeys.unregister': this.unregisterHotkey(id, String(args[0] ?? '')); break;
    }
  }

  // ---- request/response calls (PH_INVOKE) -------------------------------
  async handleHostInvoke(sender: Electron.WebContents, raw: unknown): Promise<unknown> {
    const m = raw as { method?: string; args?: unknown[] };
    if (!m.method) return { error: 'bad-request' };
    const id = this.resolvePlugin(sender);
    if (!id) return { error: 'not-allowed' };
    if (!this.rateOk(sender)) return { error: 'rate-limited' };
    const need = INVOKE_PERM[m.method];
    if (need === undefined) return { error: 'unknown-method' };
    if (need && !this.granted(id, need)) return { error: 'permission-denied' };

    const args = m.args ?? [];
    try {
      switch (m.method) {
        case 'storageGet': return this.readStorage(id)[args[0] as string];
        case 'storageAll': return this.readStorage(id);
        case 'getAccounts': return this.deps.getAccounts();
        case 'http': return await this.doHttp(id, args[0]);
        case 'files.save': return await this.doFileSave(args[0]);
        case 'files.open': return await this.doFileOpen(args[0]);
        case 'fs.read': return await this.doFsRead(id, args[0]);
        case 'fs.write': return await this.doFsWrite(id, args[0], args[1]);
        case 'fs.delete': return await this.doFsDelete(id, args[0]);
        case 'fs.list': return await this.doFsList(id, args[0]);
        case 'fs.stat': return await this.doFsStat(id, args[0]);
        case 'hotkeys.register': return this.registerHotkey(id, String(args[0] ?? ''));
      }
    } catch (e) {
      return { error: String((e as { message?: string })?.message ?? e) };
    }
    return { error: 'unknown-method' };
  }

  /** Post a desktop notification on a plugin's behalf. The ORIGIN (the plugin's
   *  name, read from its on-disk manifest — never anything the plugin supplies)
   *  is shown as the title so the user always knows which plugin spoke; the
   *  plugin's own title/body go in the body. */
  private doNotify(id: string, arg: unknown) {
    const o = (arg ?? {}) as { title?: string; body?: string };
    const d = this.discovered.get(id);
    const origin = (d?.manifest.name || id).slice(0, 120);
    const body = [String(o.title ?? ''), String(o.body ?? '')].filter(Boolean).join(' — ').slice(0, 1000);
    try { new Notification({ title: origin, body }).show(); } catch { /* ignore */ }
  }

  /** Fire the OS copy/paste action on whatever field currently has focus — which
   *  may be a Discord account view, a plugin window, or the chrome UI. This
   *  exposes NO data to the plugin: it only triggers the same action the user's
   *  Ctrl/Cmd+C / +V would, on whatever they currently have focused. */
  private fireClipboard(kind: 'copy' | 'paste') {
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.isFocused())
      ?? (BrowserWindow.getFocusedWindow() ?? this.getOwnerWindow())?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (kind === 'copy') wc.copy(); else wc.paste();
  }

  private async doHttp(id: string, req: unknown): Promise<unknown> {
    const r = (req ?? {}) as { url?: string; method?: string; headers?: Record<string, string>; body?: string | Uint8Array };
    const url = String(r.url ?? '');
    if (!/^https?:\/\//i.test(url)) return { error: 'only http(s) urls allowed' };
    let host: string;
    try { host = new URL(url).hostname; } catch { return { error: 'invalid url' }; }
    // SSRF guard: refuse to let a plugin reach loopback / private / link-local
    // (incl. the 169.254.169.254 cloud-metadata IP) addresses. (Residual: this
    // validates the initial host; a redirect or DNS rebind to an internal
    // address afterwards is not re-checked.)
    if (await isBlockedHost(host)) return { error: 'destination not allowed' };
    const inflight = this.httpInflight.get(id) ?? 0;
    if (inflight >= MAX_HTTP_CONCURRENCY) return { error: 'too many concurrent requests' };
    this.httpInflight.set(id, inflight + 1);
    try {
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
    } finally {
      this.httpInflight.set(id, (this.httpInflight.get(id) ?? 1) - 1);
    }
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

  // ---- contained per-plugin filesystem (`filesystem` permission) ---------
  /** Resolve a plugin-relative path inside its private folder, or null if it
   *  escapes (absolute paths, `..`, etc. are rejected). */
  private fsResolve(id: string, rel: unknown): string | null {
    const base = path.join(this.fsDir, id);
    const p = path.resolve(base, String(rel ?? ''));
    if (p !== base && !p.startsWith(base + path.sep)) return null;
    return p;
  }
  /** Current byte usage of a plugin's folder (scanned once, then maintained). */
  private fsUsed(id: string): number {
    let u = this.fsUsage.get(id);
    if (u === undefined) { u = dirSize(path.join(this.fsDir, id)); this.fsUsage.set(id, u); }
    return u;
  }

  private async doFsWrite(id: string, rel: unknown, data: unknown): Promise<unknown> {
    const target = this.fsResolve(id, rel);
    if (!target) return { error: 'invalid path' };
    const buf = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data ?? ''), 'utf8');
    let prev = 0;
    try { prev = (await fs.promises.stat(target)).size; } catch { /* new file */ }
    // Counts against the same per-plugin budget as key/value storage.
    if (this.kvBytes(id) + this.fsUsed(id) - prev + buf.byteLength > this.deps.getStorageLimitBytes()) {
      return { error: 'quota-exceeded' };
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, buf);
    this.fsUsage.set(id, Math.max(0, this.fsUsed(id) - prev + buf.byteLength));
    return { ok: true, size: buf.byteLength };
  }

  private async doFsRead(id: string, rel: unknown): Promise<unknown> {
    const target = this.fsResolve(id, rel);
    if (!target) return { error: 'invalid path' };
    try {
      const stat = await fs.promises.stat(target);
      if (!stat.isFile()) return { error: 'not a file' };
      return { ok: true, data: new Uint8Array(await fs.promises.readFile(target)) };
    } catch { return { error: 'not found' }; }
  }

  private async doFsDelete(id: string, rel: unknown): Promise<unknown> {
    const target = this.fsResolve(id, rel);
    if (!target) return { error: 'invalid path' };
    // Never allow deleting the plugin's root via an empty path.
    if (target === path.join(this.fsDir, id)) return { error: 'invalid path' };
    try {
      const stat = await fs.promises.stat(target);
      const freed = stat.isFile() ? stat.size : dirSize(target);
      await fs.promises.rm(target, { recursive: true, force: true });
      this.fsUsage.set(id, Math.max(0, this.fsUsed(id) - freed));
    } catch { /* already gone */ }
    return { ok: true };
  }

  private async doFsList(id: string, rel: unknown): Promise<unknown> {
    const target = this.fsResolve(id, rel);
    if (!target) return { error: 'invalid path' };
    try {
      const entries = await fs.promises.readdir(target, { withFileTypes: true });
      const files = await Promise.all(entries.map(async (e) => {
        let size = 0;
        if (e.isFile()) { try { size = (await fs.promises.stat(path.join(target, e.name))).size; } catch { /* ignore */ } }
        return { name: e.name, dir: e.isDirectory(), size };
      }));
      return { ok: true, files };
    } catch { return { ok: true, files: [] }; }
  }

  private async doFsStat(id: string, rel: unknown): Promise<unknown> {
    const target = this.fsResolve(id, rel);
    if (!target) return { error: 'invalid path' };
    try {
      const s = await fs.promises.stat(target);
      return { ok: true, exists: true, dir: s.isDirectory(), size: s.isFile() ? s.size : 0 };
    } catch { return { ok: true, exists: false }; }
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
    // A focused plugin window swallows keystrokes that would otherwise reach the
    // chrome/account views, breaking the keyboard-fallback path for Push-to-Talk.
    // Mirror those views by forwarding raw input to the same global handler.
    w.webContents.on('before-input-event', (_e, input) => this.deps.forwardInput(input));
    w.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('http')) shell.openExternal(url); return { action: 'deny' }; });
    w.on('closed', () => { this.uiCtx.delete(w.webContents.id); this.rate.delete(w.webContents.id); this.windows.delete(id); });
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
    this.rate.delete(view.webContents.id);
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
    const host = this.hostWcFor(id);
    if (host) host.send(IPC.phMsg, { t: 'event', name, payload });
    for (const wc of this.uiContextsFor(id)) wc.send(IPC.phMsg, { t: 'event', name, payload });
  }

  /** Fan a broadcast out to every context of the plugin except the originator. */
  private deliverBroadcast(id: string, channel: string, data: unknown, exceptWcId?: number, exceptAccountId?: string) {
    const host = this.hostWcFor(id);
    if (host && host.id !== exceptWcId) host.send(IPC.phMsg, { t: 'broadcast', channel, data });
    for (const wc of this.uiContextsFor(id)) if (wc.id !== exceptWcId) wc.send(IPC.phMsg, { t: 'broadcast', channel, data });
    this.deps.dispatchToContent(id, { t: 'broadcast', channel, data }, exceptAccountId);
  }

  /** Content script (Discord view) broadcasting to the plugin's other contexts.
   *  The sender proves its identity by echoing the per-plugin relay key main
   *  injected into its isolated world — the claimed plugin id is derived from
   *  that key, never trusted from the message, so a content script cannot
   *  broadcast as a different plugin. */
  handleContentMsg(p: { accountId: string; relayKey: string; channel: string; data: unknown }) {
    const id = this.keyOwner.get(p.relayKey);
    if (!id || !this.isEnabled(id) || !this.granted(id, 'discord-view')) return;
    this.deliverBroadcast(id, String(p.channel), p.data, undefined, p.accountId);
  }

  /** Stable per-plugin relay key authenticating its content-script broadcasts. */
  private relayKeyFor(id: string): string {
    let k = this.contentKey.get(id);
    if (!k) { k = randomUUID(); this.contentKey.set(id, k); this.keyOwner.set(k, id); }
    return k;
  }
  private dropRelayKey(id: string) {
    const k = this.contentKey.get(id);
    if (k) this.keyOwner.delete(k);
    this.contentKey.delete(id);
  }

  /** Content scripts to inject into each Discord view (enabled + discord-view
   *  granted). Each carries a relay key so its broadcasts can be authenticated. */
  getContentScripts(): { pluginId: string; code: string; relayKey: string }[] {
    return [...this.discovered.values()]
      .filter((d) => this.isEnabled(d.manifest.id) && d.contentScript && this.granted(d.manifest.id, 'discord-view'))
      .map((d) => ({ pluginId: d.manifest.id, code: d.contentScript as string, relayKey: this.relayKeyFor(d.manifest.id) }));
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
    for (const id of this.targetsFor('notifications')) {
      const host = this.hostWcFor(id);
      if (host) host.send(IPC.phMsg, { t: 'event', name: 'notification', payload });
    }
    // also deliver to notification-granted plugins' UI contexts
    for (const id of new Set([...this.windows.keys(), ...this.panels.keys()])) {
      if (this.isEnabled(id) && this.granted(id, 'notifications')) for (const wc of this.uiContextsFor(id)) wc.send(IPC.phMsg, { t: 'event', name: 'notification', payload });
    }
  }

  emitAccounts(snapshot: unknown[]) {
    for (const id of this.targetsFor('accounts')) {
      const host = this.hostWcFor(id);
      if (host) host.send(IPC.phMsg, { t: 'accounts', snapshot });
    }
    for (const id of new Set([...this.windows.keys(), ...this.panels.keys()])) {
      if (this.isEnabled(id) && this.granted(id, 'accounts')) for (const wc of this.uiContextsFor(id)) wc.send(IPC.phMsg, { t: 'accounts', snapshot });
    }
  }

  // ---- renderer-driven controls -----------------------------------------
  setEnabled(id: string, on: boolean) {
    if (!this.perms[id]) this.perms[id] = { enabled: false, permissions: {} };
    this.perms[id].enabled = on;
    if (!on) { this.discordCss.delete(id); this.clearHotkeys(id); this.dropRelayKey(id); }
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
    if (perm === 'discord-view' && !granted) this.dropRelayKey(id);
    this.writePerms();
    this.reloadHost();
    this.recomputeCss();
    this.deps.onChange();
  }

  reload() {
    for (const id of [...this.windows.keys()]) this.closeWindow(id);
    for (const id of [...this.panels.keys()]) this.closePanel(id);
    for (const id of [...this.hotkeys.keys()]) this.clearHotkeys(id);
    for (const id of [...this.hosts.keys()]) this.destroyHost(id); // recreate fresh against new code
    this.discover();
    this.discordCss.clear();
    this.syncHosts();
    this.recomputeCss();
    this.deps.reinjectContent();
    this.deps.onChange();
  }

  openFolder() { shell.openPath(this.dir).catch(() => undefined); }

  destroy() {
    this.flushStorageNow();
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.destroy();
    this.windows.clear();
    this.panels.clear();
    for (const id of [...this.hotkeys.keys()]) this.clearHotkeys(id);
    for (const id of [...this.hosts.keys()]) this.destroyHost(id);
  }
}

/** Total byte size of a directory tree (metadata-only stat walk). */
function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else { try { total += fs.statSync(p).size; } catch { /* ignore */ } }
  }
  return total;
}

// ---- SSRF guard ----------------------------------------------------------
/** True if a host should not be reachable by plugin http: loopback, private,
 *  link-local (incl. 169.254.169.254 cloud metadata), CGNAT and other reserved
 *  ranges. Hostnames are resolved and every resolved address is checked. */
async function isBlockedHost(host: string): Promise<boolean> {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const fam = isIP(h);
  if (fam) return isPrivateAddr(h, fam);
  try {
    const addrs = await dns.promises.lookup(h, { all: true });
    if (!addrs.length) return true;
    return addrs.some((a) => isPrivateAddr(a.address, a.family));
  } catch {
    return true; // unresolvable → don't fetch
  }
}

function isPrivateAddr(addr: string, family: number): boolean {
  if (family === 4) return isPrivateV4(addr);
  const a = addr.toLowerCase();
  if (a === '::1' || a === '::') return true;
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // fc00::/7 unique-local
  if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true; // fe80::/10 link-local
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

function isPrivateV4(addr: string): boolean {
  const o = addr.split('.').map((n) => parseInt(n, 10));
  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return true;
  const [a, b] = o;
  if (a === 0 || a === 127) return true; // this-host / loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + 255.255.255.255
  return false;
}
