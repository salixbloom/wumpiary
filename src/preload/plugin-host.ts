import { contextBridge, ipcRenderer, webFrame } from 'electron';

// Sandboxed preload for a hidden plugin-host window. There is now ONE host
// window PER enabled headless plugin (not a single shared context), so the main
// process can derive the authoritative plugin id from the IPC sender and never
// has to trust an id carried in the message. That removes the old cross-plugin
// impersonation hole where any plugin sharing the host realm could call the
// bridge claiming another plugin's id and borrow its permissions / read its
// storage. See src/main/plugins.ts.
//
// This preload does NOT run plugin code itself (that would expose ipcRenderer);
// it exposes a tiny message bridge to the page's main world and injects a
// runtime there that evaluates THIS host's single plugin. Plugin code runs in
// the main world, which — thanks to the host page's CSP (connect-src 'none', no
// remote origins) — has no network and no Node. The only thing it can reach is
// the curated `wumpiary` API the runtime builds, every outbound effect of which
// is re-validated against the plugin's granted permissions back in main.
//
// Channel names are inlined (not imported from ../shared/ipc) because a
// sandboxed preload cannot pull in sibling chunks — same constraint as
// account-observer.ts.
const PH_MSG = 'pluginhost:msg'; // main -> host
const PH_CALL = 'pluginhost:call'; // host -> main (fire-and-forget)
const PH_INVOKE = 'pluginhost:invoke'; // host -> main (request/response)

let deliver: ((m: unknown) => void) | null = null;

contextBridge.exposeInMainWorld('__wumpBridge', {
  onMessage: (cb: (m: unknown) => void) => {
    deliver = cb;
  },
  send: (msg: unknown) => ipcRenderer.send(PH_CALL, msg),
  invoke: (msg: unknown) => ipcRenderer.invoke(PH_INVOKE, msg),
});

ipcRenderer.on(PH_MSG, (_e, m) => deliver?.(m));

// ---- main-world runtime (stringified and injected) -----------------------
// Authored as a normal function so it type-checks and reads naturally; it must
// reference ONLY browser globals + window.__wumpBridge (no outer-scope
// bindings) because it executes in a different world via executeJavaScript.
// This host runs exactly ONE plugin, so there is no per-plugin routing here.
function runtime() {
  const bridge = (window as unknown as {
    __wumpBridge: {
      onMessage: (cb: (m: unknown) => void) => void;
      send: (m: unknown) => void;
      invoke: (m: unknown) => Promise<unknown>;
    };
  }).__wumpBridge;

  let pluginId = '';
  let handlers: Record<string, Set<(p: unknown) => void>> = {};
  let cleanup: unknown = null;
  let accounts: unknown[] = [];

  function err(e: unknown) {
    bridge.send({ t: 'error', message: String((e as { message?: string })?.message ?? e) });
  }

  function makeApi(perms: string[], storage: Record<string, unknown>) {
    handlers = {};
    const has = (p: string) => perms.indexOf(p) !== -1;
    // The id is informational only — main authenticates by IPC sender, so a
    // forged id in an outbound message is ignored. We still send it for clarity.
    const call = (method: string, args: unknown[]) => bridge.send({ t: 'call', method, args });
    const invoke = (method: string, args: unknown[]) => bridge.invoke({ t: 'invoke', method, args });
    const api: Record<string, unknown> = {
      id: pluginId,
      on: (name: string, cb: (p: unknown) => void) => {
        (handlers[name] || (handlers[name] = new Set())).add(cb);
        return () => handlers[name] && handlers[name].delete(cb);
      },
      log: (...a: unknown[]) => call('log', a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))),
      storage: {
        get: (k: string, d?: unknown) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : d),
        set: (k: string, v: unknown) => { storage[k] = v; call('storageSet', [k, v]); },
        delete: (k: string) => { delete storage[k]; call('storageDelete', [k]); },
        all: () => JSON.parse(JSON.stringify(storage)),
      },
      // Intra-plugin message bus: reaches this plugin's other contexts (UI
      // window, panel, Discord content scripts). Always available.
      broadcast: (channel: string, data?: unknown) => call('broadcast', [String(channel), data]),
      // Standalone window control (the config panel is opened by the user from
      // Settings, not by the plugin).
      window: { open: () => call('window.open', []), close: () => call('window.close', []) },
    };
    if (has('accounts')) api.getAccounts = () => JSON.parse(JSON.stringify(accounts));
    if (has('notifications')) api.notify = (o: { title?: string; body?: string }) => call('notify', [{ title: String(o?.title ?? ''), body: String(o?.body ?? '') }]);
    if (has('discord-css')) api.setDiscordCss = (css: string) => call('setDiscordCss', [String(css ?? '')]);
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
    // Clipboard is fire-only: a plugin can trigger the OS copy/paste action on
    // the focused field but can never READ clipboard or selection contents.
    if (has('clipboard')) api.clipboard = { copy: () => call('clipboard.copy', []), paste: () => call('clipboard.paste', []) };
    if (has('hotkeys')) api.hotkeys = { register: (accel: string) => invoke('hotkeys.register', [String(accel ?? '')]), unregister: (accel: string) => call('hotkeys.unregister', [String(accel ?? '')]) };
    return api;
  }

  function unload() {
    try { if (typeof cleanup === 'function') (cleanup as () => void)(); } catch { /* ignore */ }
    cleanup = null;
    handlers = {};
  }

  function load(p: { id: string; code: string; perms: string[]; storage: Record<string, unknown> }) {
    unload();
    pluginId = p.id || '';
    try {
      const api = makeApi(p.perms || [], p.storage || {});
      const mod: { exports: unknown } = { exports: {} };
      // eslint-disable-next-line no-new-func
      const fn = new Function('module', 'exports', 'wumpiary', `${p.code}\n//# sourceURL=wumpiary-plugin/${pluginId}`);
      fn(mod, (mod as { exports: unknown }).exports, api);
      const exp = mod.exports as { activate?: (a: unknown) => unknown } | ((a: unknown) => unknown);
      const activate = typeof exp === 'function' ? exp : exp && exp.activate;
      if (typeof activate === 'function') cleanup = activate(api);
    } catch (e) {
      err(e);
    }
  }

  function dispatch(name: string, payload: unknown) {
    const set = handlers[name];
    if (!set) return;
    for (const cb of Array.from(set)) {
      try { cb(payload); } catch (e) { err(e); }
    }
  }

  bridge.onMessage((raw: unknown) => {
    const m = raw as { t: string; [k: string]: unknown };
    if (m.t === 'load') load(m as unknown as { id: string; code: string; perms: string[]; storage: Record<string, unknown> });
    else if (m.t === 'unload') unload();
    else if (m.t === 'event') dispatch(m.name as string, m.payload);
    else if (m.t === 'accounts') { accounts = m.snapshot as unknown[]; dispatch('accounts', accounts); }
    else if (m.t === 'broadcast') dispatch('message:' + (m.channel as string), m.data);
  });

  bridge.send({ t: 'ready' });
}

const RUNTIME = `(${runtime.toString()})();`;
window.addEventListener('DOMContentLoaded', () => {
  webFrame.executeJavaScript(RUNTIME).catch((e) => console.error('[plugin-host] runtime inject failed', e));
});
