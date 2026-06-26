import { ipcRenderer, webFrame } from 'electron';

// Channels inlined (kept in sync with shared/ipc.ts) so this sandboxed preload
// bundles to a single self-contained file with no sibling-chunk requires.
const IPC = {
  obMetrics: 'observer:metrics',
  obTheme: 'observer:theme',
  obNotification: 'observer:notification',
  obConnection: 'observer:connection',
  obFill: 'observer:fill',
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
  function cssVar(style, names) {
    for (const name of names) {
      const v = style.getPropertyValue(name).trim();
      if (v) return v;
    }
    return '';
  }
  function theme() {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const name = Array.from(root.classList).find((c) => c.indexOf('theme-') === 0) || null;
    post({
      __wump: 'theme',
      name: name,
      appFrameBackground: cssVar(style, ['--app-frame-background']),
      bg: cssVar(style, ['--background-base-lowest', '--background-primary', '--bg-base-primary']),
      bg2: cssVar(style, ['--background-base-lower', '--background-secondary', '--bg-base-secondary']),
      bg3: cssVar(style, ['--background-base-low', '--background-tertiary', '--bg-base-tertiary']),
      bgHover: cssVar(style, ['--background-modifier-hover', '--bg-mod-faint']),
      text: cssVar(style, ['--text-primary', '--header-primary']),
      textDim: cssVar(style, ['--text-muted', '--text-secondary', '--header-secondary']),
      border: cssVar(style, ['--border-subtle', '--background-modifier-accent'])
    });
  }

  const start = () => {
    metrics(); conn(); theme();
    const titleEl = document.querySelector('title');
    if (titleEl) new MutationObserver(metrics).observe(titleEl, { childList: true, characterData: true, subtree: true });
    new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    setInterval(metrics, 5000);
    setInterval(conn, 5000);
    setInterval(theme, 5000);
    window.addEventListener('online', conn);
    window.addEventListener('offline', conn);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`;

webFrame.executeJavaScript(INJECT).catch(() => undefined);

// ---- login autofill (user-initiated, PIN-gated upstream) -----------------
// Filling the login form is the one place this preload writes to the page. It
// runs entirely in THIS isolated world (never the page's main world, so Discord
// scripts can't read the credentials) and only sets the standard email/password
// inputs via the native value setter + an `input` event so React picks them up.
// The user still solves any captcha/2FA and clicks Log In themselves.
function fillField(selector: string, value: string): boolean {
  const el = document.querySelector(selector) as HTMLInputElement | null;
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

ipcRenderer.on(IPC.obFill, (_e, p: { email?: string; password?: Uint8Array | null }) => {
  let pw = '';
  try {
    if (p.email) fillField('input[name=email]', p.email);
    if (p.password && p.password.length) {
      pw = new TextDecoder().decode(p.password);
      fillField('input[name=password]', pw);
    }
  } catch {
    /* ignore */
  } finally {
    // Best-effort wipe of the plaintext we held.
    pw = '';
    try { if (p.password) (p.password as Uint8Array).fill(0); } catch { /* ignore */ }
  }
});

// Relay main-world messages (shared DOM EventTarget crosses isolated worlds).
window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as { __wump?: string; [k: string]: unknown };
  if (!d || typeof d !== 'object') return;
  if (d.__wump === 'notif') {
    ipcRenderer.send(IPC.obNotification, { accountId, title: d.title, body: d.body, kind: d.kind });
  } else if (d.__wump === 'metrics') {
    ipcRenderer.send(IPC.obMetrics, { accountId, unread: d.unread, mentions: d.mentions });
  } else if (d.__wump === 'theme') {
    ipcRenderer.send(IPC.obTheme, {
      accountId,
      name: d.name,
      appFrameBackground: d.appFrameBackground,
      bg: d.bg,
      bg2: d.bg2,
      bg3: d.bg3,
      bgHover: d.bgHover,
      text: d.text,
      textDim: d.textDim,
      border: d.border,
    });
  } else if (d.__wump === 'conn') {
    ipcRenderer.send(IPC.obConnection, { accountId, state: d.state });
  }
});
