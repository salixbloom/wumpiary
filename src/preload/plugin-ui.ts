import { contextBridge, ipcRenderer } from 'electron';

// Preload for a plugin's UI surfaces — its standalone window and its interior
// panel. Unlike the headless host (one shared context for all plugins' entry
// scripts), each UI surface is a single-plugin context loading that plugin's own
// HTML from the wumpiary-plugin://<id>/ origin. The plugin's page scripts run in
// the main world; this isolated preload exposes a frozen `window.wumpiary` to
// them via contextBridge, so they still never touch ipcRenderer/Node directly.
//
// The plugin id and its GRANTED permissions are passed as process arguments by
// the main process when it creates the window/panel. They only decide which
// methods are *offered* here; the main process re-validates every call against
// the authoritative permission record and derives the plugin id from the sender,
// not from anything this context claims (see src/main/plugins.ts).
const PH_MSG = 'pluginhost:msg';
const PH_CALL = 'pluginhost:call';
const PH_INVOKE = 'pluginhost:invoke';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';
const pluginId = arg('plugin-id');
const perms = arg('plugin-perms').split(',').filter(Boolean);
const has = (p: string) => perms.indexOf(p) !== -1;

const handlers: Record<string, Set<(p: unknown) => void>> = {};
function dispatch(name: string, payload: unknown) {
  const set = handlers[name];
  if (!set) return;
  for (const cb of Array.from(set)) {
    try { cb(payload); } catch (e) { console.error('[plugin-ui] handler error', e); }
  }
}

ipcRenderer.on(PH_MSG, (_e, raw: unknown) => {
  const m = raw as { t: string; [k: string]: unknown };
  if (m.t === 'event') dispatch(m.name as string, m.payload);
  else if (m.t === 'accounts') dispatch('accounts', m.snapshot);
  else if (m.t === 'broadcast') dispatch('message:' + (m.channel as string), m.data);
});

const send = (method: string, args: unknown[]) => ipcRenderer.send(PH_CALL, { t: 'call', pluginId, method, args });
const invoke = (method: string, args: unknown[]) => ipcRenderer.invoke(PH_INVOKE, { t: 'invoke', pluginId, method, args });

const api: Record<string, unknown> = {
  id: pluginId,
  on: (name: string, cb: (p: unknown) => void) => {
    (handlers[name] || (handlers[name] = new Set())).add(cb);
    return () => handlers[name] && handlers[name].delete(cb);
  },
  log: (...a: unknown[]) => send('log', a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))),
  // Storage is shared with the plugin's other contexts (host/panel/window), so
  // it is async here (fetched from main rather than preloaded).
  storage: {
    get: (k: string, d?: unknown) => invoke('storageGet', [k]).then((v) => (v === undefined ? d : v)),
    set: (k: string, v: unknown) => send('storageSet', [k, v]),
    delete: (k: string) => send('storageDelete', [k]),
    all: () => invoke('storageAll', []),
  },
  broadcast: (channel: string, data?: unknown) => send('broadcast', [String(channel), data]),
  window: { open: () => send('window.open', []), close: () => send('window.close', []) },
};
if (has('accounts')) api.getAccounts = () => invoke('getAccounts', []);
if (has('notifications')) api.notify = (o: { title?: string; body?: string }) => send('notify', [{ title: String(o?.title ?? ''), body: String(o?.body ?? '') }]);
if (has('discord-css')) api.setDiscordCss = (css: string) => send('setDiscordCss', [String(css ?? '')]);
if (has('network')) api.http = (req: unknown) => invoke('http', [req]);
if (has('files')) api.files = { save: (o: unknown) => invoke('files.save', [o]), open: (o: unknown) => invoke('files.open', [o]) };
// Contained, app-managed private folder (no native dialogs, no access to the
// user's real files). Paths are relative to the plugin's own folder.
if (has('filesystem')) api.fs = {
  read: (p: string) => invoke('fs.read', [String(p ?? '')]),
  write: (p: string, data: unknown) => invoke('fs.write', [String(p ?? ''), data]),
  delete: (p: string) => invoke('fs.delete', [String(p ?? '')]),
  list: (p?: string) => invoke('fs.list', [String(p ?? '')]),
  stat: (p: string) => invoke('fs.stat', [String(p ?? '')]),
};
// Clipboard is fire-only: a plugin can trigger the OS copy/paste action on the
// focused field but can never READ clipboard or selection contents.
if (has('clipboard')) api.clipboard = { copy: () => send('clipboard.copy', []), paste: () => send('clipboard.paste', []) };
if (has('hotkeys')) api.hotkeys = { register: (accel: string) => invoke('hotkeys.register', [String(accel ?? '')]), unregister: (accel: string) => send('hotkeys.unregister', [String(accel ?? '')]) };

contextBridge.exposeInMainWorld('wumpiary', api);
