import { BrowserWindow, WebContentsView, session, shell } from 'electron';
import { randomUUID } from 'crypto';
import { ConfigStore } from './config';
import { IPC } from '../shared/ipc';
import { AccountRuntime, ConnectionState, defaultAccountColors, newAccountConfig } from '../shared/types';

const DISCORD_URL = 'https://discord.com/app';
const TITLE_BAR_HEIGHT = 34;

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

  constructor(
    private win: BrowserWindow,
    private observerPreload: string,
    private cfg: ConfigStore,
    private onRuntime: (id: string, patch: Partial<AccountRuntime>) => void,
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

  private createView(id: string): WebContentsView {
    const acc = this.cfg.get().accounts[id];
    const view = new WebContentsView({
      webPreferences: {
        preload: this.observerPreload,
        partition: acc.partition, // isolated, persistent cookie jar per account
        backgroundThrottling: false, // critical: keep the gateway heartbeat alive while hidden
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
        additionalArguments: [`--acct=${id}`],
      },
    });
    const wc = view.webContents;
    const ses = ses_for(acc.partition);
    if (acc.proxy) ses.setProxy({ proxyRules: acc.proxy }).catch(() => undefined);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'fullscreen'));

    // Open external links in the system browser, not inside the account view.
    wc.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http')) shell.openExternal(url);
      return { action: 'deny' };
    });

    // Re-apply plugin CSS after every navigation (insertCSS is cleared on load).
    wc.on('dom-ready', () => this.applyCssTo(id));

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
    wc.loadURL(DISCORD_URL);
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
    const ses = ses_for(acc.partition);
    await ses.clearStorageData();
    this.cfg.update((c) => (c.accounts[id].signedIn = false));
    const view = this.views.get(id);
    if (view) view.webContents.loadURL(DISCORD_URL);
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

  setConnection(id: string, state: ConnectionState) {
    this.onRuntime(id, { connection: state });
    if (state === 'connected') this.cfg.update((c) => { if (c.accounts[id]) c.accounts[id].signedIn = true; });
    if (state === 'signed-out') this.cfg.update((c) => { if (c.accounts[id]) c.accounts[id].signedIn = false; });
  }
}

function ses_for(partition: string) {
  return session.fromPartition(partition);
}
