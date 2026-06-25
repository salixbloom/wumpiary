import { ipcRenderer, webFrame } from 'electron';

// Channels inlined (kept in sync with shared/ipc.ts) so this sandboxed preload
// bundles to a single self-contained file with no sibling-chunk requires.
const IPC = {
  obMetrics: 'observer:metrics',
  obNotification: 'observer:notification',
  obConnection: 'observer:connection',
} as const;

// OBSERVE-ONLY bridge injected into each Discord account view. It never changes
// Discord's behaviour beyond capturing the Notification it would have shown
// (so we can re-emit it tagged + filtered). It reads unread/mention counts from
// the title and reports connection state. Nothing is automated or sent on the
// user's behalf. See PLAN.md §4 / §10.

const accountId = process.argv.find((a) => a.startsWith('--acct='))?.slice('--acct='.length) ?? '?';

// Injected into the page's MAIN world (bypasses CSP via webFrame; required to
// wrap window.Notification and read document.title). It only posts messages out
// via window.postMessage — the isolated preload below relays them to main.
const INJECT = `(() => {
  if (window.__wumpInstalled) return; window.__wumpInstalled = true;
  const post = (m) => { try { window.postMessage(m, '*'); } catch (e) {} };

  // Capture (do not display) Discord's web notifications.
  try {
    const Orig = window.Notification;
    function classify(title, body) {
      const hay = ((title || '') + ' ' + (body || '')).toLowerCase();
      if (/ring|incoming call|calling/.test(hay)) return 'call';
      return (title && title.indexOf('#') !== -1) ? 'mention' : 'dm';
    }
    function Wump(title, options) {
      const body = (options && options.body) || '';
      post({ __wump: 'notif', title: title || 'Discord', body: body, kind: classify(title, body) });
      return { close(){}, addEventListener(){}, removeEventListener(){}, onclick: null };
    }
    Wump.permission = 'granted';
    Wump.requestPermission = (cb) => { if (cb) cb('granted'); return Promise.resolve('granted'); };
    Wump.maxActions = (Orig && Orig.maxActions) || 0;
    window.Notification = Wump;
  } catch (e) {}

  // Unread / mention counts from the document title (e.g. "(3) Discord").
  function metrics() {
    const t = document.title || '';
    const m = t.match(/\\((\\d+)\\)/);
    const mentions = m ? parseInt(m[1], 10) : 0;
    const unread = mentions > 0 ? mentions : (/[•\\u2022]/.test(t) ? 1 : 0);
    post({ __wump: 'metrics', unread: unread, mentions: mentions });
  }
  // Connection / auth state.
  function conn() {
    let state;
    if (!navigator.onLine) state = 'offline';
    else if (location.pathname.indexOf('/login') === 0 || document.querySelector('input[name=email]')) state = 'signed-out';
    else state = 'connected';
    post({ __wump: 'conn', state: state });
  }

  const start = () => {
    metrics(); conn();
    const titleEl = document.querySelector('title');
    if (titleEl) new MutationObserver(metrics).observe(titleEl, { childList: true, characterData: true, subtree: true });
    setInterval(metrics, 5000);
    setInterval(conn, 5000);
    window.addEventListener('online', conn);
    window.addEventListener('offline', conn);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`;

webFrame.executeJavaScript(INJECT).catch(() => undefined);

// Relay main-world messages (shared DOM EventTarget crosses isolated worlds).
window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as { __wump?: string; [k: string]: unknown };
  if (!d || typeof d !== 'object') return;
  if (d.__wump === 'notif') {
    ipcRenderer.send(IPC.obNotification, { accountId, title: d.title, body: d.body, kind: d.kind });
  } else if (d.__wump === 'metrics') {
    ipcRenderer.send(IPC.obMetrics, { accountId, unread: d.unread, mentions: d.mentions });
  } else if (d.__wump === 'conn') {
    ipcRenderer.send(IPC.obConnection, { accountId, state: d.state });
  }
});
