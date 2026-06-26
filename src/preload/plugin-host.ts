import { contextBridge, ipcRenderer, webFrame } from 'electron';

// Sandboxed preload for the hidden plugin-host window. It does NOT run plugin
// code itself (that would give plugins access to ipcRenderer); instead it
// exposes a tiny message bridge to the page's main world and injects a runtime
// there. Plugin code runs entirely in the main world, which — thanks to the
// host page's CSP (connect-src 'none', no remote origins) — has no network and
// no Node access. The only thing a plugin can reach is the curated `wumpiary`
// API object the runtime builds for it, every outbound effect of which is
// re-validated against the plugin's granted permissions back in the main
// process (see src/main/plugins.ts).
//
// Channel names are inlined (not imported from ../shared/ipc) because a
// sandboxed preload cannot pull in sibling chunks — same constraint as
// account-observer.ts.
const PH_MSG = 'pluginhost:msg'; // main -> host
const PH_CALL = 'pluginhost:call'; // host -> main

let deliver: ((m: unknown) => void) | null = null;

contextBridge.exposeInMainWorld('__wumpBridge', {
  // The main-world runtime registers its receiver here.
  onMessage: (cb: (m: unknown) => void) => {
    deliver = cb;
  },
  // The main-world runtime relays plugin api-calls / lifecycle here.
  send: (msg: unknown) => ipcRenderer.send(PH_CALL, msg),
});

ipcRenderer.on(PH_MSG, (_e, m) => deliver?.(m));

// ---- main-world runtime (stringified and injected) -----------------------
// Authored as a normal function so it type-checks and reads naturally; it must
// reference ONLY browser globals + window.__wumpBridge (no outer-scope
// bindings) because it executes in a different world via executeJavaScript.
function runtime() {
  const bridge = (window as unknown as { __wumpBridge: { onMessage: (cb: (m: unknown) => void) => void; send: (m: unknown) => void } }).__wumpBridge;
  interface Loaded {
    handlers: Record<string, Set<(p: unknown) => void>>;
    cleanup: unknown;
  }
  const plugins = new Map<string, Loaded>();
  let accounts: unknown[] = [];

  function err(pluginId: string, e: unknown) {
    bridge.send({ t: 'error', pluginId, message: String((e as { message?: string })?.message ?? e) });
  }

  function makeApi(id: string, perms: string[], storage: Record<string, unknown>) {
    const handlers: Record<string, Set<(p: unknown) => void>> = {};
    const has = (p: string) => perms.indexOf(p) !== -1;
    const api: Record<string, unknown> = {
      id,
      on: (name: string, cb: (p: unknown) => void) => {
        (handlers[name] || (handlers[name] = new Set())).add(cb);
        return () => handlers[name] && handlers[name].delete(cb);
      },
      log: (...a: unknown[]) => bridge.send({ t: 'call', pluginId: id, method: 'log', args: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) }),
      storage: {
        get: (k: string, d?: unknown) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : d),
        set: (k: string, v: unknown) => { storage[k] = v; bridge.send({ t: 'call', pluginId: id, method: 'storageSet', args: [k, v] }); },
        delete: (k: string) => { delete storage[k]; bridge.send({ t: 'call', pluginId: id, method: 'storageDelete', args: [k] }); },
        all: () => JSON.parse(JSON.stringify(storage)),
      },
    };
    if (has('accounts')) api.getAccounts = () => JSON.parse(JSON.stringify(accounts));
    if (has('notifications')) api.notify = (o: { title?: string; body?: string }) => bridge.send({ t: 'call', pluginId: id, method: 'notify', args: [{ title: String(o?.title ?? ''), body: String(o?.body ?? '') }] });
    if (has('discord-css')) api.setDiscordCss = (css: string) => bridge.send({ t: 'call', pluginId: id, method: 'setDiscordCss', args: [String(css ?? '')] });
    return { api, handlers };
  }

  function unload() {
    for (const [, p] of plugins) {
      try { if (typeof p.cleanup === 'function') (p.cleanup as () => void)(); } catch { /* ignore */ }
    }
    plugins.clear();
  }

  function load(list: Array<{ id: string; code: string; perms: string[]; storage: Record<string, unknown> }>) {
    unload();
    for (const p of list) {
      try {
        const { api, handlers } = makeApi(p.id, p.perms, p.storage || {});
        const mod: { exports: unknown } = { exports: {} };
        // eslint-disable-next-line no-new-func
        const fn = new Function('module', 'exports', 'wumpiary', `${p.code}\n//# sourceURL=wumpiary-plugin/${p.id}`);
        fn(mod, (mod as { exports: unknown }).exports, api);
        const exp = mod.exports as { activate?: (a: unknown) => unknown } | ((a: unknown) => unknown);
        const activate = typeof exp === 'function' ? exp : exp && exp.activate;
        let cleanup: unknown = null;
        if (typeof activate === 'function') cleanup = activate(api);
        plugins.set(p.id, { handlers, cleanup });
      } catch (e) {
        err(p.id, e);
      }
    }
  }

  function dispatch(name: string, payload: unknown, targets: string[]) {
    for (const id of targets) {
      const p = plugins.get(id);
      if (!p) continue;
      const set = p.handlers[name];
      if (!set) continue;
      for (const cb of set) {
        try { cb(payload); } catch (e) { err(id, e); }
      }
    }
  }

  bridge.onMessage((raw: unknown) => {
    const m = raw as { t: string; [k: string]: unknown };
    if (m.t === 'load') load(m.plugins as Array<{ id: string; code: string; perms: string[]; storage: Record<string, unknown> }>);
    else if (m.t === 'unload') unload();
    else if (m.t === 'event') dispatch(m.name as string, m.payload, m.targets as string[]);
    else if (m.t === 'accounts') { accounts = m.snapshot as unknown[]; dispatch('accounts', accounts, m.targets as string[]); }
  });

  bridge.send({ t: 'ready' });
}

const RUNTIME = `(${runtime.toString()})();`;
window.addEventListener('DOMContentLoaded', () => {
  webFrame.executeJavaScript(RUNTIME).catch((e) => console.error('[plugin-host] runtime inject failed', e));
});
