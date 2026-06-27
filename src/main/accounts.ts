import { app, BrowserWindow, WebContentsView, session, shell } from 'electron';
import { randomUUID } from 'crypto';
import { ConfigStore } from './config';
import { IPC } from '../shared/ipc';
import { isCustomSound } from './notifications';
import { AccountRuntime, ConnectionState, defaultAccountColors, newAccountConfig } from '../shared/types';

const DISCORD_URL = 'https://discord.com/app';
const DISCORD_LOGIN_URL = 'https://discord.com/login';
const TITLE_BAR_HEIGHT = 34;

// Cosmetic CSS injected into every Discord view to show, with a green ring around
// your own avatar, that you're currently holding the push-to-talk key.
//   - `.wump-me-ptt` is added by the observer (account-observer.ts) to *your*
//     avatar wherever it appears in a voice/call/panel context (bottom-left pfp,
//     the voice-connected panel, your tile inside a call) — identified by your
//     user id, so it covers every scenario at once.
//   - `html.wump-ptt-held` is a fallback that rings the bottom-left user panel
//     even when you have no custom avatar (so there's no user id to match).
// Both override Discord's voice-activity speaking ring. Update if Discord changes
// its markup.
const PTT_RING = 'box-shadow: 0 0 0 2px #23a559, 0 0 9px 1px rgba(35, 165, 89, 0.75) !important; border-radius: 50% !important; transition: box-shadow 0.08s ease;';
const PTT_HELD_CSS = `
.wump-me-ptt { ${PTT_RING} }
html.wump-ptt-held [class*="panels_"] [class*="avatar_"],
html.wump-ptt-held [class*="avatarWrapper_"] [class*="avatar_"] { ${PTT_RING} }
`;

// Per-view runtime for `discord-view` plugin content scripts. Injected (once
// per page) into each Discord view's MAIN world via executeJavaScript so it can
// touch the page DOM. It runs each granted plugin's content script with a
// curated `wumpiary` object and relays broadcasts out via window.postMessage,
// which account-observer (isolated world) forwards to main. main -> content
// delivery calls window.__wumpPluginRT.dispatch(...) by executeJavaScript.
// This is the explicit, user-granted, off-by-default exception to observe-only.
function contentRuntime(accountId: string): string {
  return `(() => {
  if (window.__wumpPluginRT) return;
  const ACCOUNT_ID = ${JSON.stringify(accountId)};
  const post = (m) => { try { window.postMessage(m, '*'); } catch (e) {} };
  const findBox = () =>
    document.querySelector('[role="textbox"][contenteditable="true"]') ||
    document.querySelector('div[class*="slateContainer"] [contenteditable="true"]') ||
    document.querySelector('textarea');
  function makeInput() {
    const setNative = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(el, value); else el.value = value;
    };
    return {
      targetMessageBox: () => { const b = findBox(); if (b) b.focus(); return !!b; },
      focusMessageBox: () => { const b = findBox(); if (b) b.focus(); return !!b; },
      type: (text) => {
        const b = findBox(); if (!b) return false; b.focus();
        if (b.isContentEditable) { document.execCommand('insertText', false, String(text)); }
        else { setNative(b, (b.value || '') + String(text)); b.dispatchEvent(new Event('input', { bubbles: true })); }
        return true;
      },
      send: () => {
        const b = findBox(); if (!b) return false; b.focus();
        const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        b.dispatchEvent(new KeyboardEvent('keydown', o));
        b.dispatchEvent(new KeyboardEvent('keyup', o));
        return true;
      },
      click: (sel) => { const el = document.querySelector(sel); if (el) { el.click(); return true; } return false; },
      getSelectionText: () => { try { return String(window.getSelection()); } catch (e) { return ''; } },
      wait: (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(60000, ms | 0)))),
    };
  }
  function makeApi(pluginId) {
    const handlers = {};
    return {
      handlers,
      api: {
        accountId: ACCOUNT_ID,
        pluginId: pluginId,
        query: (sel) => document.querySelector(sel),
        queryAll: (sel) => Array.prototype.slice.call(document.querySelectorAll(sel)),
        onMutation: (cb) => {
          const mo = new MutationObserver(() => { try { cb(); } catch (e) {} });
          mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
          return () => mo.disconnect();
        },
        addStyle: (css) => {
          const el = document.createElement('style');
          el.textContent = String(css || '');
          (document.head || document.documentElement).appendChild(el);
          return () => { try { el.remove(); } catch (e) {} };
        },
        hide: (el) => { if (el && el.classList) el.classList.add('wump-hidden'); },
        reveal: (el) => { if (el && el.classList) el.classList.remove('wump-hidden'); },
        log: function () { try { console.log('[content:' + pluginId + ']', ...arguments); } catch (e) {} },
        broadcast: (channel, data) => post({ __wumpPlugin: 'broadcast', pluginId: pluginId, channel: String(channel), data: data }),
        on: (name, cb) => { (handlers[name] || (handlers[name] = new Set())).add(cb); return () => handlers[name] && handlers[name].delete(cb); },
        input: makeInput(),
      },
    };
  }
  const RT = {
    plugins: {},
    run: function (pluginId, code) {
      this.stop(pluginId);
      try {
        const built = makeApi(pluginId);
        // eslint-disable-next-line no-new-func
        const fn = new Function('wumpiary', code + '\\n//# sourceURL=wumpiary-content/' + pluginId);
        built.cleanup = fn(built.api);
        this.plugins[pluginId] = built;
      } catch (e) { post({ __wumpPlugin: 'error', pluginId: pluginId, message: String((e && e.message) || e) }); }
    },
    stop: function (pluginId) {
      const p = this.plugins[pluginId];
      if (p && typeof p.cleanup === 'function') { try { p.cleanup(); } catch (e) {} }
      delete this.plugins[pluginId];
    },
    stopAll: function () { for (const id in this.plugins) this.stop(id); },
    dispatch: function (pluginId, msg) {
      const p = this.plugins[pluginId]; if (!p) return;
      if (msg && msg.t === 'broadcast') {
        const set = p.handlers['message:' + msg.channel]; if (!set) return;
        set.forEach((cb) => { try { cb(msg.data); } catch (e) {} });
      }
    },
  };
  const st = document.createElement('style');
  st.textContent = '.wump-hidden{display:none !important;}';
  (document.head || document.documentElement).appendChild(st);
  window.__wumpPluginRT = RT;
})();`;
}

/**
 * Owns one isolated WebContentsView per account and applies the resource &
 * stability policy validated in the Phase-0 spike (see SPIKE_FINDINGS.md):
 *
 *   - backgroundThrottling:false on every connected view  -> heartbeat survives
 *   - only the ACTIVE view is setVisible(true); others stay alive but
 *     un-rendered (no paint/GPU cost) while keeping their gateway connected
 *   - hibernation destroys the WebContents to reclaim RAM (account goes offline)
 */
export class AccountManager {
  private views = new Map<string, WebContentsView>();
  /** epoch ms of last activation, for auto-hibernate. */
  readonly lastActive = new Map<string, number>();
  private overlay = false;
  activeId: string | null = null;
  /** Combined cosmetic CSS contributed by plugins (discord-css permission). */
  private pluginCss = '';
  private cssKeys = new Map<string, string>(); // viewId -> insertCSS handle
  private pttEnabled = false;
  private pttPressed = false;
  /** Supplies the content scripts (plugin id + source) to inject into every
   *  Discord view — only enabled plugins granted `discord-view`. Set by the
   *  controller after the PluginManager is constructed. */
  private contentScripts?: () => { pluginId: string; code: string }[];

  constructor(
    private win: BrowserWindow,
    private observerPreload: string,
    private cfg: ConfigStore,
    private onRuntime: (id: string, patch: Partial<AccountRuntime>) => void,
    private onInput?: (input: { type?: string; code?: string; control?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }) => void,
    private onChooseDesktopSource?: () => Promise<Electron.DesktopCapturerSource | null>,
  ) {}

  /** Recreate connected views on launch (crash/restart recovery). */
  init() {
    const c = this.cfg.get();
    for (const id of c.accountsOrder) {
      const acc = c.accounts[id];
      if (acc && !acc.hibernated) this.createView(id);
      else if (acc) this.onRuntime(id, { connection: 'hibernated', unread: 0, mentions: 0 });
    }
    const restore = c.lastActiveId && c.accounts[c.lastActiveId] && !c.accounts[c.lastActiveId].hibernated ? c.lastActiveId : c.accountsOrder.find((id) => !c.accounts[id]?.hibernated) ?? null;
    if (restore) this.setActive(restore);
    this.layout();
  }

  private createView(id: string, url = DISCORD_URL): WebContentsView {
    const acc = this.cfg.get().accounts[id];
    const view = new WebContentsView({
      webPreferences: {
        preload: this.observerPreload,
        partition: acc.partition, // isolated, persistent cookie jar per account
        backgroundThrottling: false, // critical: keep the gateway heartbeat alive while hidden
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
        autoplayPolicy: 'no-user-gesture-required', // let incoming call/stream video autoplay
        additionalArguments: [`--acct=${id}`, `--ptt-enabled=${this.cfg.get().global.pushToTalk.enabled ? '1' : '0'}`],
      },
    });
    const wc = view.webContents;
    const ses = ses_for(acc.partition);
    // Present as a plain Chrome browser (strip the Electron + app tokens) so
    // Discord serves its WEB streaming path — watching streams and screen share
    // work over pure WebRTC with no native module. Identifying as the desktop
    // app instead makes Discord demand the (absent) DiscordNative and break the
    // whole stream UI. Set on both the session and webContents.
    const ua = browserUserAgent();
    ses.setUserAgent(ua);
    wc.setUserAgent(ua);
    if (acc.proxy) ses.setProxy({ proxyRules: acc.proxy }).catch(() => undefined);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'fullscreen'));
    // Enable "Go Live" / screen sharing: without a display-media handler Chromium
    // rejects getDisplayMedia. Ask the user to choose a screen or window (Electron
    // 31 has no native system picker), then hand the chosen source back.
    ses.setDisplayMediaRequestHandler((_request, callback) => {
      const choose = this.onChooseDesktopSource ?? (() => Promise.resolve(null));
      choose()
        .then((source) => callback(source ? { video: source } : {}))
        .catch(() => callback({}));
    });

    // Open external links in the system browser, not inside the account view.
    wc.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http')) shell.openExternal(url);
      return { action: 'deny' };
    });

    // Re-apply injected CSS after every navigation (insertCSS is cleared on load).
    wc.on('dom-ready', () => {
      this.applyCssTo(id);
      wc.insertCSS(PTT_HELD_CSS).catch(() => undefined); // static; cleared with the page on next nav
      this.sendPushToTalkState(view);
      this.sendSoundConfig(view, id);
      this.injectContentScripts(id, wc);
    });
    wc.on('before-input-event', (_e, input) => this.onInput?.(input));

    wc.on('did-start-loading', () => this.onRuntime(id, { connection: 'loading' }));
    wc.on('did-fail-load', (_e, code) => {
      if (code !== -3) this.onRuntime(id, { connection: 'offline' }); // -3 = aborted (navigation), ignore
    });
    wc.on('render-process-gone', () => {
      // Crash recovery: rebuild the view in place.
      this.views.delete(id);
      if (!this.cfg.get().accounts[id]?.hibernated) {
        this.createView(id);
        this.layout();
      }
    });

    view.setVisible(false);
    this.win.contentView.addChildView(view);
    wc.loadURL(url);
    this.views.set(id, view);
    this.lastActive.set(id, Date.now());
    this.onRuntime(id, { connection: 'loading' });
    return view;
  }

  /** Position all account views to the content area left/right of the sidebar. */
  layout() {
    const ui = this.cfg.get().ui;
    const [w, h] = this.win.getContentSize();
    const sb = ui.sidebarCollapsed ? 64 : ui.sidebarWidth;
    const x = ui.sidebarSide === 'left' ? sb : 0;
    const width = Math.max(0, w - sb);
    for (const view of this.views.values()) view.setBounds({ x, y: TITLE_BAR_HEIGHT, width, height: Math.max(0, h - TITLE_BAR_HEIGHT) });
    this.applyVisibility();
  }

  private applyVisibility() {
    for (const [id, view] of this.views) view.setVisible(!this.overlay && id === this.activeId);
  }

  /** Hide all account views while a full-window modal / lock screen is shown. */
  setOverlay(on: boolean) {
    this.overlay = on;
    this.applyVisibility();
  }

  setActive(id: string) {
    const acc = this.cfg.get().accounts[id];
    if (!acc) return;
    if (acc.hibernated) {
      this.setHibernated(id, false);
      return;
    }
    if (!this.views.has(id)) this.createView(id);
    this.activeId = id;
    this.lastActive.set(id, Date.now());
    this.cfg.update((c) => (c.lastActiveId = id));
    this.applyVisibility();
  }

  add(): string {
    const id = randomUUID().slice(0, 8);
    const order = this.cfg.get().accountsOrder;
    const color = defaultAccountColors[order.length % defaultAccountColors.length];
    this.cfg.update((c) => {
      c.accounts[id] = newAccountConfig(id, `account ${order.length + 1}`, color);
      c.accountsOrder.push(id);
    });
    this.createView(id);
    this.setActive(id);
    this.layout();
    return id;
  }

  /** Sign out: clear the partition's auth but keep the account + perch. */
  async signOut(id: string) {
    const acc = this.cfg.get().accounts[id];
    if (!acc) return;
    const wasActive = this.activeId === id;
    const view = this.views.get(id);
    if (view) {
      this.win.contentView.removeChildView(view);
      view.webContents.close();
      this.views.delete(id);
    }
    const ses = ses_for(acc.partition);
    await ses.clearStorageData({
      storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'],
    });
    await ses.clearCache();
    this.cfg.update((c) => (c.accounts[id].signedIn = false));
    this.createView(id, DISCORD_LOGIN_URL);
    if (wasActive) this.setActive(id);
    this.layout();
    this.onRuntime(id, { connection: 'signed-out', unread: 0, mentions: 0 });
  }

  /** Forget: destroy view, wipe partition, remove config entry. */
  async forget(id: string) {
    const acc = this.cfg.get().accounts[id];
    if (!acc) return;
    const view = this.views.get(id);
    if (view) {
      this.win.contentView.removeChildView(view);
      view.webContents.close();
      this.views.delete(id);
    }
    const ses = ses_for(acc.partition);
    await ses.clearStorageData();
    await ses.clearCache();
    this.cfg.update((c) => {
      delete c.accounts[id];
      c.accountsOrder = c.accountsOrder.filter((x) => x !== id);
    });
    if (this.activeId === id) {
      const next = this.cfg.get().accountsOrder.find((x) => !this.cfg.get().accounts[x].hibernated) ?? null;
      this.activeId = null;
      if (next) this.setActive(next);
    }
    this.layout();
  }

  /** Hibernate (reclaim RAM, goes offline) or wake an account. */
  setHibernated(id: string, on: boolean) {
    const acc = this.cfg.get().accounts[id];
    if (!acc) return;
    if (on) {
      const view = this.views.get(id);
      if (view) {
        this.win.contentView.removeChildView(view);
        view.webContents.close();
        this.views.delete(id);
      }
      this.cfg.update((c) => (c.accounts[id].hibernated = true));
      this.onRuntime(id, { connection: 'hibernated', unread: 0, mentions: 0 });
      if (this.activeId === id) {
        const next = this.cfg.get().accountsOrder.find((x) => x !== id && !this.cfg.get().accounts[x].hibernated) ?? null;
        this.activeId = null;
        if (next) this.setActive(next);
      }
    } else {
      this.cfg.update((c) => (c.accounts[id].hibernated = false));
      this.createView(id);
      this.setActive(id);
    }
    this.layout();
  }

  reload(id: string) {
    this.views.get(id)?.webContents.reload();
  }

  /** Push login credentials to an account view's observer to autofill the form.
   *  `password` is a Buffer owned by the caller (wiped by the caller after). */
  fillLogin(id: string, email: string, password: Buffer | null): boolean {
    const view = this.views.get(id);
    if (!view || view.webContents.isDestroyed()) return false;
    view.webContents.send(IPC.obFill, { email, password: password ? new Uint8Array(password) : null });
    return true;
  }

  setPushToTalkState(enabled: boolean, pressed: boolean) {
    this.pttEnabled = enabled;
    this.pttPressed = pressed;
    for (const view of this.views.values()) this.sendPushToTalkState(view);
  }

  private sendPushToTalkState(view: WebContentsView) {
    if (!view.webContents.isDestroyed()) view.webContents.send(IPC.obPushToTalk, { enabled: this.pttEnabled, pressed: this.pttPressed });
  }

  private sendSoundConfig(view: WebContentsView, id: string) {
    const acc = this.cfg.get().accounts[id];
    if (!acc || view.webContents.isDestroyed()) return;
    // Mute Discord's own ding only when this account uses a custom chime.
    const muteNotifSound = isCustomSound(acc.notifications.chime);
    view.webContents.send(IPC.obSoundConfig, { muteNotifSound });
  }

  /** Re-push the sound config to a view (call when the account's chime changes). */
  refreshSoundConfig(id: string) {
    const view = this.views.get(id);
    if (view) this.sendSoundConfig(view, id);
  }

  openDevtools(id: string) {
    this.views.get(id)?.webContents.openDevTools({ mode: 'detach' });
  }

  applyProxy(id: string) {
    const acc = this.cfg.get().accounts[id];
    if (!acc) return;
    ses_for(acc.partition).setProxy({ proxyRules: acc.proxy ?? '' }).catch(() => undefined);
  }

  destroyAll() {
    for (const view of this.views.values()) {
      try {
        this.win.contentView.removeChildView(view);
        view.webContents.close();
      } catch {
        /* noop */
      }
    }
    this.views.clear();
  }

  hasView(id: string): boolean {
    return this.views.has(id);
  }

  /** Set the combined plugin CSS and (re)apply it to every live account view. */
  setPluginCss(css: string) {
    this.pluginCss = css;
    for (const id of this.views.keys()) this.applyCssTo(id);
  }

  private applyCssTo(id: string) {
    const view = this.views.get(id);
    if (!view || view.webContents.isDestroyed()) return;
    const wc = view.webContents;
    const prev = this.cssKeys.get(id);
    if (prev) { wc.removeInsertedCSS(prev).catch(() => undefined); this.cssKeys.delete(id); }
    if (this.pluginCss) wc.insertCSS(this.pluginCss).then((key) => this.cssKeys.set(id, key)).catch(() => undefined);
  }

  // ---- discord-view plugin content scripts -------------------------------
  /** Wire the provider that lists which content scripts to inject (set once at startup). */
  setContentScripts(fn: () => { pluginId: string; code: string }[]) { this.contentScripts = fn; }

  private injectContentScripts(id: string, wc: Electron.WebContents) {
    const scripts = this.contentScripts?.() ?? [];
    wc.executeJavaScript(contentRuntime(id))
      .then(() => wc.executeJavaScript('window.__wumpPluginRT && window.__wumpPluginRT.stopAll()'))
      .then(() => {
        for (const s of scripts) {
          wc.executeJavaScript(`window.__wumpPluginRT && window.__wumpPluginRT.run(${JSON.stringify(s.pluginId)}, ${JSON.stringify(s.code)})`).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }

  /** Re-evaluate content scripts in every live view (enable/permission/reload changes). */
  reinjectContentScripts() {
    for (const [id, view] of this.views) {
      const wc = view.webContents;
      if (!wc.isDestroyed()) this.injectContentScripts(id, wc);
    }
  }

  /** Deliver a broadcast/event from main into a plugin's content scripts. */
  dispatchToContentScripts(pluginId: string, msg: unknown, exceptAccountId?: string) {
    for (const [id, view] of this.views) {
      if (id === exceptAccountId) continue;
      const wc = view.webContents;
      if (wc.isDestroyed()) continue;
      wc.executeJavaScript(`window.__wumpPluginRT && window.__wumpPluginRT.dispatch(${JSON.stringify(pluginId)}, ${JSON.stringify(msg)})`).catch(() => undefined);
    }
  }

  setConnection(id: string, state: ConnectionState) {
    this.onRuntime(id, { connection: state });
    if (state === 'connected') this.cfg.update((c) => { if (c.accounts[id]) c.accounts[id].signedIn = true; });
    if (state === 'signed-out') this.cfg.update((c) => { if (c.accounts[id]) c.accounts[id].signedIn = false; });
  }
}

function ses_for(partition: string) {
  return session.fromPartition(partition);
}

/**
 * Electron's default UA with the app token and the `Electron/x` token removed,
 * leaving a clean Chrome browser UA so Discord serves its web streaming path.
 */
function browserUserAgent(): string {
  const escaped = app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return app.userAgentFallback
    .replace(new RegExp(`\\s*${escaped}\\/[^\\s]+`, 'i'), '')
    .replace(/\s*Electron\/[^\s]+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
