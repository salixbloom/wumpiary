import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, IpcMainInvokeEvent, IpcMainEvent, Menu, net, powerMonitor, protocol, session } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { pathToFileURL } from 'url';
import type { z } from 'zod';
import { RendererSchemas, ObserverSchemas } from '../shared/schemas';
import { ConfigStore } from './config';
import { Vault } from './vault';
import { AccountManager } from './accounts';
import { NotificationRouter, ObserverNotification } from './notifications';
import { AppTray } from './tray';
import { registerHotkeys, unregisterHotkeys } from './hotkeys';
import { PushToTalkHook } from './push-to-talk-hook';
import { initUpdater } from './updater';
import { PluginManager } from './plugins';
import { IPC } from '../shared/ipc';
import { AccountPatch, AccountRuntime, ActivityEntry, AppState, ConnectionState, GlobalConfig, GlobalPatch, ShellTheme, UiConfig } from '../shared/types';

class AppController {
  private cfg = new ConfigStore();
  private vault = new Vault();
  private win!: BrowserWindow;
  private accounts!: AccountManager;
  private router!: NotificationRouter;
  private plugins!: PluginManager;
  private tray?: AppTray;

  private locked = true;
  private runtime: Record<string, AccountRuntime> = {};
  private shellThemes: Record<string, ShellTheme> = {};
  private activity: ActivityEntry[] = [];
  private failed = 0;
  private lockoutUntil = 0;
  private isQuitting = false;
  private stateTimer: NodeJS.Timeout | null = null;
  private pushToTalkPressed = false;
  private pendingSourcePick: ((id: string | null) => void) | null = null;
  private pushToTalkHook = new PushToTalkHook((pressed) => {
    this.setPushToTalkPressed(pressed, true);
  });

  start() {
    // Brand Windows toast notifications (and group them in the Action Center)
    // under our own AppUserModelID. Only do this when packaged: the installer
    // registers a Start-Menu shortcut carrying this exact AUMID, which Windows
    // needs to resolve the toast. In dev there is no such shortcut, so overriding
    // it would make Windows silently drop every notification — keep Electron's
    // working default there.
    if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('com.wumpiary.app');
    this.applyChromeCsp();
    this.registerAppProtocol();
    this.createWindow();
    this.accounts = new AccountManager(
      this.win,
      path.join(__dirname, '../preload/account-observer.js'),
      this.cfg,
      (id, patch) => this.onRuntime(id, patch),
      (input) => this.onPushToTalkInput(input),
      () => this.chooseDesktopSource(),
    );
    this.plugins = new PluginManager(
      path.join(__dirname, '../preload/plugin-host.js'),
      (css) => this.accounts.setPluginCss(css),
      () => this.scheduleState(),
    );
    this.plugins.init();
    this.router = new NotificationRouter(
      this.cfg,
      (id) => this.activate(id),
      (id, chime) => this.win.webContents.send(IPC.playChime, { accountId: id, chime }),
      (entry) => { this.activity.unshift(entry); this.activity = this.activity.slice(0, 200); this.scheduleState(); },
      (p) => { this.markNotifying(p.accountId); this.plugins.emitNotification(p); },
    );
    try {
      this.tray = new AppTray(this.cfg, {
        onShow: () => this.showWindow(),
        onToggleDnd: () => this.patchGlobal({ dnd: !this.cfg.get().global.dnd }),
        onLock: () => this.lock(),
        onQuit: () => this.quit(),
        onActivate: (id) => this.activate(id),
      });
    } catch (e) {
      console.warn('[tray] unavailable (no system tray host?)', e);
    }
    this.registerIpc();
    this.startTimers();

    registerHotkeys({
      nextAccount: () => this.cycle(1),
      prevAccount: () => this.cycle(-1),
      toggleSidebar: () => this.patchUi({ sidebarCollapsed: !this.cfg.get().ui.sidebarCollapsed }),
      toggleDnd: () => this.patchGlobal({ dnd: !this.cfg.get().global.dnd }),
      lock: () => this.lock(),
    });

    // Always start locked: nothing is decrypted and no account view is created
    // until the user authenticates (or sets a PIN on first run).
    this.accounts.setOverlay(true);
  }

  /**
   * Lock down the chrome UI with a strict CSP in production only. In dev we skip
   * it so Vite's HMR / React-Refresh inline preamble works. This applies to the
   * default session (the chrome window); account views use their own partitions
   * and keep Discord's own CSP untouched.
   */
  private applyChromeCsp() {
    if (process.env['ELECTRON_RENDERER_URL']) return; // dev
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file: wumpiary:; media-src 'self' file: wumpiary:; connect-src 'self'";
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }

  private registerAppProtocol() {
    protocol.handle('wumpiary', (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'sfx') return new Response(null, { status: 404 });
      const requested = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const allowed = new Set([
        'ptta.mp3',
        'pttd.mp3',
      ]);
      if (!allowed.has(requested)) return new Response(null, { status: 404 });
      const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
      return net.fetch(pathToFileURL(path.join(base, 'resources', 'sfx', requested)).toString());
    });
  }

  private createWindow() {
    this.win = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 860,
      minHeight: 560,
      show: false,
      autoHideMenuBar: true,
      frame: false,
      backgroundColor: '#1e1f22',
      title: 'wumpiary',
      webPreferences: {
        preload: path.join(__dirname, '../preload/chrome.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.win.setMenuBarVisibility(false);

    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl) this.win.loadURL(devUrl).catch((e) => console.error('[main] loadURL failed', e));
    else this.win.loadFile(path.join(__dirname, '../renderer/index.html')).catch((e) => console.error('[main] loadFile failed', e));

    this.win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('[main] did-fail-load', code, desc, url));
    this.win.webContents.on('console-message', (_e, level, msg) => {
      if (level >= 2) console.warn('[renderer]', msg);
    });
    this.win.webContents.on('before-input-event', (_e, input) => this.onPushToTalkInput(input));

    this.win.on('ready-to-show', () => {
      if (!this.cfg.get().global.startMinimized) this.win.show();
    });
    this.win.on('resize', () => this.accounts.layout());
    this.win.on('blur', () => {
      if (!this.pushToTalkHook.status().active && this.pushToTalkPressed) {
        this.setPushToTalkPressed(false, true);
      }
    });
    this.win.on('close', (e) => {
      if (!this.isQuitting) {
        e.preventDefault();
        this.win.hide();
      }
    });
  }

  // ---- state -------------------------------------------------------------
  private ensureRuntime(id: string): AccountRuntime {
    if (!this.runtime[id]) {
      const hib = this.cfg.get().accounts[id]?.hibernated;
      this.runtime[id] = { id, unread: 0, mentions: 0, connection: hib ? 'hibernated' : 'offline', inCall: false, notifying: false };
    }
    return this.runtime[id];
  }

  private onRuntime(id: string, patch: Partial<AccountRuntime>) {
    const prevConnection = this.runtime[id]?.connection;
    Object.assign(this.ensureRuntime(id), patch);
    if (patch.connection === 'signed-out' && prevConnection !== 'signed-out' && id === this.accounts?.activeId) {
      this.promptAutofillIfUseful(id);
    }
    this.scheduleState();
  }

  private buildState(): AppState {
    const c = this.cfg.get();
    for (const id of c.accountsOrder) this.ensureRuntime(id);
    // prune runtime for removed accounts
    for (const id of Object.keys(this.runtime)) if (!c.accounts[id]) delete this.runtime[id];
    const totalMentions = c.accountsOrder.reduce((a, id) => a + (this.runtime[id]?.mentions ?? 0), 0);
    return {
      hasVault: this.vault.hasVault,
      locked: this.locked,
      activeId: this.accounts?.activeId ?? null,
      config: c,
      runtime: this.runtime,
      activity: this.activity.slice(0, 100),
      totalMentions,
      encryptionAvailable: this.vault.encryptionAvailable,
      plugins: this.plugins?.getInfos() ?? [],
      savedLogins: this.vault.unlocked ? this.vault.listCredentials() : {},
      shellTheme: this.accounts?.activeId ? this.shellThemes[this.accounts.activeId] ?? null : null,
      pushToTalkStatus: this.pushToTalkHook.status(),
    };
  }

  /** Sanitized per-account snapshot for plugins holding the `accounts` perm. */
  private pluginAccounts() {
    const c = this.cfg.get();
    return c.accountsOrder.map((id) => {
      const a = c.accounts[id];
      const r = this.runtime[id];
      return {
        id,
        nickname: a?.nickname ?? '',
        color: a?.color ?? '',
        connection: r?.connection ?? 'offline',
        unread: r?.unread ?? 0,
        mentions: r?.mentions ?? 0,
        hibernated: !!a?.hibernated,
        signedIn: !!a?.signedIn,
      };
    });
  }

  private scheduleState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      const s = this.buildState();
      this.win.webContents.send(IPC.stateChanged, s);
      this.tray?.refresh(s.totalMentions);
      if (!this.locked) this.plugins.emitAccounts(this.pluginAccounts());
    }, 60);
  }

  // ---- lifecycle actions -------------------------------------------------
  private afterUnlock() {
    this.locked = false;
    this.accounts.init();
    this.accounts.setOverlay(false);
    this.plugins.startHost(); // load plugins only after the user has unlocked
    this.applyGlobal();
    this.applyPushToTalk();
    this.scheduleState();
  }

  private lock() {
    if (this.locked || !this.vault.hasVault) return;
    this.vault.lock();
    this.locked = true;
    // Keep account views alive (still receiving notifications) but hidden.
    this.accounts.setOverlay(true);
    this.win.webContents.send(IPC.stateChanged, this.buildState());
  }

  private activate(id: string) {
    this.showWindow();
    if (this.locked) return;
    this.accounts.setActive(id);
    if (this.runtime[id]?.notifying) this.onRuntime(id, { notifying: false }); // opened it — stop the shake
    if (this.runtime[id]?.connection === 'signed-out') this.promptAutofillIfUseful(id);
    this.scheduleState();
  }

  /** Flag that a notification was just surfaced from an account, so its avatar
   *  shakes — unless you're already looking at it. Cleared when you open it. */
  private markNotifying(id: string) {
    if (id === this.accounts?.activeId) return;
    this.onRuntime(id, { notifying: true });
  }

  private promptAutofillIfUseful(id: string) {
    if (!this.vault.unlocked) return;
    const creds = this.vault.listCredentials();
    if (!creds[id]?.email) return;
    this.win.webContents.send(IPC.promptAutofill, { accountId: id });
  }

  private cycle(dir: number) {
    if (this.locked) return;
    const order = this.cfg.get().accountsOrder.filter((id) => !this.cfg.get().accounts[id].hibernated);
    if (!order.length) return;
    const cur = this.accounts.activeId ? order.indexOf(this.accounts.activeId) : -1;
    const next = order[(cur + dir + order.length) % order.length];
    this.activate(next);
  }

  showWindow() {
    if (!this.win.isVisible()) this.win.show();
    this.win.focus();
  }

  /**
   * Screen-share source picker. Enumerates screens + windows and asks the
   * renderer to show a chooser (over a hidden Discord view), then resolves with
   * the picked source — or null if cancelled.
   */
  private async chooseDesktopSource(): Promise<Electron.DesktopCapturerSource | null> {
    let sources: Electron.DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });
    } catch {
      return null;
    }
    const payload = sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
    this.showWindow();
    // Resolve any previous pending pick (shouldn't normally happen) as cancelled.
    this.pendingSourcePick?.(null);
    const id = await new Promise<string | null>((resolve) => {
      this.pendingSourcePick = resolve;
      this.win.webContents.send(IPC.showSourcePicker, { sources: payload });
    });
    this.pendingSourcePick = null;
    return sources.find((s) => s.id === id) ?? null;
  }

  private snoozeAccount(id: string, until: number | null) {
    this.cfg.update((c) => { if (c.accounts[id]) c.accounts[id].notifications.snoozeUntil = until; });
    this.scheduleState();
  }

  private setMuted(id: string, muted: boolean) {
    this.cfg.update((c) => { if (c.accounts[id]) c.accounts[id].notifications.muted = muted; });
    this.scheduleState();
  }

  private confirmForget(id: string) {
    const acc = this.cfg.get().accounts[id];
    if (!acc) return;
    const choice = dialog.showMessageBoxSync(this.win, {
      type: 'warning',
      buttons: ['Cancel', 'Forget'],
      defaultId: 0,
      cancelId: 0,
      title: 'Forget account',
      message: `Forget "${acc.nickname}"?`,
      detail: 'This wipes its session and removes it from wumpiary.',
    });
    if (choice === 1) this.accounts.forget(id);
  }

  /**
   * Native per-account right-click menu. Built in main (not HTML) so it composites
   * ABOVE the Discord WebContentsView — an HTML menu can never rise above a native
   * child view regardless of z-index.
   */
  private showAccountMenu(id: string) {
    const c = this.cfg.get();
    const acc = c.accounts[id];
    if (!acc) return;
    const signedOut = (this.runtime[id]?.connection ?? 'offline') === 'signed-out';
    const hasSavedPassword = !!(this.vault.unlocked && this.vault.listCredentials()[id]?.password);

    const snooze = (mins: number | 'tomorrow' | 'clear') => {
      if (mins === 'clear') return this.snoozeAccount(id, null);
      if (mins === 'tomorrow') {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        return this.snoozeAccount(id, d.getTime());
      }
      return this.snoozeAccount(id, Date.now() + mins * 60_000);
    };

    const template: MenuItemConstructorOptions[] = [
      { label: acc.nickname, enabled: false },
      { type: 'separator' },
    ];
    if (signedOut && hasSavedPassword) {
      template.push({ label: 'Autofill sign-in…', click: () => this.promptAutofillIfUseful(id) });
      template.push({ type: 'separator' });
    }
    template.push(
      {
        label: acc.notifications.muted ? 'Unmute notifications' : 'Mute notifications',
        click: () => this.setMuted(id, !acc.notifications.muted),
      },
      {
        label: 'Snooze',
        submenu: [
          { label: '15 minutes', click: () => snooze(15) },
          { label: '1 hour', click: () => snooze(60) },
          { label: 'Until tomorrow', click: () => snooze('tomorrow') },
          { label: 'Clear snooze', click: () => snooze('clear') },
        ],
      },
      { type: 'separator' },
      {
        label: acc.hibernated ? 'Wake account' : 'Hibernate (save RAM, stops notifications)',
        click: () => { this.accounts.setHibernated(id, !acc.hibernated); this.scheduleState(); },
      },
      { label: 'Reload', enabled: !acc.hibernated, click: () => this.accounts.reload(id) },
      { label: 'Account settings…', click: () => this.win.webContents.send(IPC.openAccountSettings, { accountId: id }) },
      { label: 'Open devtools', enabled: !acc.hibernated, click: () => this.accounts.openDevtools(id) },
      { type: 'separator' },
      { label: 'Quick sign out (keep perch)', click: () => this.accounts.signOut(id) },
      { label: 'Forget account…', click: () => this.confirmForget(id) },
    );

    Menu.buildFromTemplate(template).popup({ window: this.win });
  }

  private applyGlobal() {
    const g = this.cfg.get().global;
    app.setLoginItemSettings({ openAtLogin: g.autoLaunch, openAsHidden: g.startMinimized });
  }

  private patchUi(patch: Partial<UiConfig>) {
    this.cfg.update((c) => Object.assign(c.ui, patch));
    this.accounts?.layout();
    this.scheduleState();
  }

  private patchGlobal(patch: GlobalPatch) {
    this.cfg.update((c) => {
      const { pushToTalk, ...rest } = patch;
      Object.assign(c.global, rest);
      if (pushToTalk) Object.assign(c.global.pushToTalk, pushToTalk);
    });
    this.applyGlobal();
    this.applyPushToTalk();
    this.scheduleState();
  }

  private onPushToTalkInput(input: { type?: string; code?: string; control?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }) {
    const ptt = this.cfg.get().global.pushToTalk;
    if (!ptt.enabled || isModifierCode(ptt.key)) return;
    if (input.type === 'keyDown' && !this.matchesPushToTalk(input, ptt)) return;
    if (input.type === 'keyUp' && input.code !== ptt.key) return;
    const pressed = input.type === 'keyDown';
    this.setPushToTalkPressed(pressed, true);
  }

  private matchesPushToTalk(
    input: { code?: string; control?: boolean; alt?: boolean; shift?: boolean; meta?: boolean },
    ptt: GlobalConfig['pushToTalk'],
  ) {
    return (
      input.code === ptt.key &&
      !!input.control === ptt.ctrl &&
      !!input.alt === ptt.alt &&
      !!input.shift === ptt.shift &&
      !!input.meta === ptt.meta
    );
  }

  private applyPushToTalk() {
    const enabled = this.cfg.get().global.pushToTalk.enabled;
    this.pushToTalkHook.configure(this.cfg.get().global.pushToTalk);
    if (!enabled) this.setPushToTalkPressed(false, false);
    this.broadcastPushToTalk();
  }

  private setPushToTalkPressed(pressed: boolean, audible: boolean) {
    if (this.pushToTalkPressed === pressed) return;
    this.pushToTalkPressed = pressed;
    this.broadcastPushToTalk();
    if (audible && this.cfg.get().global.pushToTalk.enabled) this.playPushToTalkSound(pressed ? 'activate' : 'deactivate');
  }

  private broadcastPushToTalk() {
    const enabled = this.cfg.get().global.pushToTalk.enabled;
    this.accounts?.setPushToTalkState(enabled, this.pushToTalkPressed);
  }

  private playPushToTalkSound(kind: 'activate' | 'deactivate') {
    const ptt = this.cfg.get().global.pushToTalk;
    const configured = kind === 'activate' ? ptt.activateSound : ptt.deactivateSound;
    const sound = this.resolvePushToTalkSound(configured, kind);
    if (sound !== 'none') this.win.webContents.send(IPC.playSound, { sound });
  }

  private resolvePushToTalkSound(configured: string, kind: 'activate' | 'deactivate') {
    if (!configured || configured === 'default') {
      const file = kind === 'activate' ? 'ptta.mp3' : 'pttd.mp3';
      return `wumpiary://sfx/${encodeURIComponent(file)}`;
    }
    return configured;
  }

  private onTheme(theme: ShellTheme & { accountId?: string }) {
    const accountId = theme.accountId;
    if (!accountId) return;
    const { accountId: _accountId, ...shellTheme } = theme;
    this.shellThemes[accountId] = shellTheme;
    if (this.accounts?.activeId === accountId) {
      this.scheduleState();
    }
  }

  // ---- IPC ---------------------------------------------------------------
  private registerIpc() {
    // Validate every inbound payload against its schema before dispatch; reject
    // malformed messages (PLAN.md §11). `invoke` is request/response, `on` is
    // fire-and-forget from the observer preloads.
    const invoke = <A extends unknown[]>(
      channel: string,
      schema: z.ZodType<A>,
      fn: (e: IpcMainInvokeEvent, ...args: A) => unknown,
    ) => {
      ipcMain.handle(channel, (e, ...args: unknown[]) => {
        const r = schema.safeParse(args);
        if (!r.success) {
          console.warn(`[ipc] rejected ${channel}:`, r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
          return { ok: false, error: 'invalid payload' };
        }
        return fn(e, ...(r.data as A));
      });
    };
    const on = <A extends unknown[]>(
      channel: string,
      schema: z.ZodType<A>,
      fn: (e: IpcMainEvent, ...args: A) => void,
    ) => {
      ipcMain.on(channel, (e, ...args: unknown[]) => {
        const r = schema.safeParse(args);
        if (r.success) fn(e, ...(r.data as A));
      });
    };

    invoke(IPC.getState, RendererSchemas.getState, () => this.buildState());

    invoke(IPC.setupPin, RendererSchemas.setupPin, (_e, pin) => {
      if (this.vault.hasVault) return { ok: false };
      this.vault.setup(pin);
      this.afterUnlock();
      return { ok: true };
    });

    invoke(IPC.unlock, RendererSchemas.unlock, (_e, pin) => {
      const now = Date.now();
      if (now < this.lockoutUntil) return { ok: false, waitMs: this.lockoutUntil - now };
      if (this.vault.unlock(pin)) {
        this.failed = 0;
        this.afterUnlock();
        return { ok: true };
      }
      this.failed += 1;
      if (this.failed >= 5) this.lockoutUntil = now + Math.min(60_000, 2 ** (this.failed - 5) * 5_000);
      return { ok: false, attempts: this.failed };
    });

    invoke(IPC.lock, RendererSchemas.lock, () => { this.lock(); return { ok: true }; });

    const guard = <T>(fn: () => T) => (this.locked ? undefined : fn());

    invoke(IPC.addAccount, RendererSchemas.addAccount, () => guard(() => this.accounts.add()));
    invoke(IPC.signOut, RendererSchemas.signOut, (_e, id) => guard(() => this.accounts.signOut(id)));
    invoke(IPC.forget, RendererSchemas.forget, (_e, id) => guard(() => this.accounts.forget(id)));
    invoke(IPC.setActive, RendererSchemas.setActive, (_e, id) => guard(() => this.activate(id)));
    invoke(IPC.setHibernated, RendererSchemas.setHibernated, (_e, id, on) => guard(() => { this.accounts.setHibernated(id, on); this.scheduleState(); }));
    invoke(IPC.reload, RendererSchemas.reload, (_e, id) => guard(() => this.accounts.reload(id)));
    invoke(IPC.openDevtools, RendererSchemas.openDevtools, (_e, id) => guard(() => this.accounts.openDevtools(id)));

    invoke(IPC.reorder, RendererSchemas.reorder, (_e, order) => guard(() => {
      this.cfg.update((c) => { c.accountsOrder = order.filter((id) => c.accounts[id]); });
      this.scheduleState();
    }));

    invoke(IPC.updateAccount, RendererSchemas.updateAccount, (_e, id, patch: AccountPatch) => guard(() => {
      this.cfg.update((c) => {
        const a = c.accounts[id];
        if (!a) return;
        if (patch.nickname !== undefined) a.nickname = patch.nickname;
        if (patch.color !== undefined) a.color = patch.color;
        if (patch.avatarOverride !== undefined) a.avatarOverride = patch.avatarOverride;
        if (patch.proxy !== undefined) a.proxy = patch.proxy;
        if (patch.notifications) Object.assign(a.notifications, patch.notifications);
        if (patch.calls) Object.assign(a.calls, patch.calls);
      });
      if (patch.proxy !== undefined) this.accounts.applyProxy(id);
      if (patch.notifications?.chime !== undefined) this.accounts.refreshSoundConfig(id);
      this.scheduleState();
    }));

    invoke(IPC.snooze, RendererSchemas.snooze, (_e, id, until) => guard(() => this.snoozeAccount(id, until)));
    invoke(IPC.showAccountMenu, RendererSchemas.showAccountMenu, (_e, id) => guard(() => this.showAccountMenu(id)));
    invoke(IPC.pickSource, RendererSchemas.pickSource, (_e, id) => { this.pendingSourcePick?.(id); this.pendingSourcePick = null; return { ok: true }; });

    invoke(IPC.patchUi, RendererSchemas.patchUi, (_e, patch: Partial<UiConfig>) => guard(() => this.patchUi(patch)));
    invoke(IPC.patchGlobal, RendererSchemas.patchGlobal, (_e, patch: GlobalPatch) => guard(() => this.patchGlobal(patch)));
    invoke(IPC.setOverlay, RendererSchemas.setOverlay, (_e, on) => guard(() => this.accounts.setOverlay(on)));
    invoke(IPC.setWindowBackground, RendererSchemas.setWindowBackground, (_e, color) => {
      this.win.setBackgroundColor(color || '#1e1f22');
      return { ok: true };
    });
    invoke(IPC.windowMinimize, RendererSchemas.windowMinimize, () => { this.win.minimize(); return { ok: true }; });
    invoke(IPC.windowToggleMaximize, RendererSchemas.windowToggleMaximize, () => {
      if (this.win.isMaximized()) this.win.unmaximize();
      else this.win.maximize();
      return { ok: true };
    });
    invoke(IPC.windowClose, RendererSchemas.windowClose, () => { this.win.close(); return { ok: true }; });
    invoke(IPC.clearActivity, RendererSchemas.clearActivity, () => guard(() => { this.activity = []; this.scheduleState(); }));

    // saved login / autofill
    invoke(IPC.saveLogin, RendererSchemas.saveLogin, (_e, id, email, password, pin) => guard(() => {
      const buf = Buffer.from(password, 'utf8');
      const ok = this.vault.setCredential(pin, id, email, buf);
      buf.fill(0); // wipe plaintext
      this.scheduleState();
      return { ok };
    }));
    invoke(IPC.clearLogin, RendererSchemas.clearLogin, (_e, id) => guard(() => { this.vault.deleteCredential(id); this.scheduleState(); return { ok: true }; }));
    invoke(IPC.autofillLogin, RendererSchemas.autofillLogin, (_e, id, pin) => guard(() => {
      if (!this.vault.verifyPin(pin)) return { ok: false, error: 'wrong-pin' };
      const email = this.vault.getEmail(id) ?? '';
      const pw = this.vault.decryptPassword(pin, id); // caller-owned Buffer
      const filled = this.accounts.fillLogin(id, email, pw);
      if (pw) pw.fill(0); // wipe immediately after handing off
      return { ok: filled };
    }));

    // plugins (renderer -> main)
    invoke(IPC.setPluginEnabled, RendererSchemas.setPluginEnabled, (_e, id, on) => guard(() => this.plugins.setEnabled(id, on)));
    invoke(IPC.setPluginPermission, RendererSchemas.setPluginPermission, (_e, id, perm, granted) => guard(() => this.plugins.setPermission(id, perm, granted)));
    invoke(IPC.reloadPlugins, RendererSchemas.reloadPlugins, () => guard(() => this.plugins.reload()));
    invoke(IPC.openPluginsFolder, RendererSchemas.openPluginsFolder, () => guard(() => this.plugins.openFolder()));

    // sandboxed plugin host -> main (re-validated inside the manager)
    ipcMain.on(IPC.phCall, (e, msg) => { if (this.plugins.isHostSender(e.sender)) this.plugins.handleHostCall(msg); });

    // observe-only events from account views (least-trusted surface)
    on(IPC.obMetrics, ObserverSchemas.obMetrics, (_e, p) => {
      this.onRuntime(p.accountId, { unread: p.unread, mentions: p.mentions });
    });
    on(IPC.obTheme, ObserverSchemas.obTheme, (_e, p) => this.onTheme(p));
    on(IPC.obConnection, ObserverSchemas.obConnection, (_e, p) => {
      this.accounts.setConnection(p.accountId, p.state as ConnectionState);
    });
    on(IPC.obCall, ObserverSchemas.obCall, (_e, p) => this.onRuntime(p.accountId, { inCall: p.active }));
    on(IPC.obNotification, ObserverSchemas.obNotification, (_e, p) => this.router.handle(p as ObserverNotification));
  }

  // ---- background timers (resource + security) ---------------------------
  private startTimers() {
    // auto-lock on idle
    setInterval(() => {
      const mins = this.cfg.get().global.autoLockMinutes;
      if (mins > 0 && !this.locked && this.vault.hasVault && powerMonitor.getSystemIdleTime() >= mins * 60) this.lock();
    }, 15_000);

    // auto-hibernate inactive accounts to reclaim RAM (opt-in; goes offline)
    setInterval(() => {
      const mins = this.cfg.get().global.autoHibernateMinutes;
      if (mins <= 0 || this.locked) return;
      const now = Date.now();
      for (const id of this.cfg.get().accountsOrder) {
        const acc = this.cfg.get().accounts[id];
        if (!acc || acc.hibernated || id === this.accounts.activeId) continue;
        const last = this.accounts.lastActive.get(id) ?? now;
        if (now - last > mins * 60_000) this.accounts.setHibernated(id, true);
      }
    }, 60_000);
  }

  quit() {
    this.isQuitting = true;
    app.quit();
  }

  shutdown() {
    unregisterHotkeys();
    this.pushToTalkHook.stop();
    this.cfg.flush();
    this.accounts?.destroyAll();
    this.plugins?.destroy();
    this.tray?.destroy();
  }
}

function isModifierCode(code: string) {
  return code === 'ControlLeft' || code === 'ControlRight' || code === 'AltLeft' || code === 'AltRight' || code === 'ShiftLeft' || code === 'ShiftRight' || code === 'MetaLeft' || code === 'MetaRight';
}

// ---- bootstrap -----------------------------------------------------------
// WSLg exposes no DRM render node (/dev/dri); Chromium's GPU process fails to
// initialize against the d3d12 path ("Exiting GPU process due to errors during
// initialization") and the window paints blank even though the DOM mounts.
// Fall back to software compositing there. Must run before app is ready.
const isWsl = os.release().toLowerCase().includes('microsoft') || !!process.env['WSL_DISTRO_NAME'];
if (isWsl) app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([
  { scheme: 'wumpiary', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const controller = new AppController();
  app.on('second-instance', () => controller.showWindow());
  app.whenReady().then(() => {
    controller.start();
    initUpdater();
    app.on('activate', () => controller.showWindow());
  });
  app.on('before-quit', () => controller.shutdown());
  app.on('window-all-closed', () => {
    // we live in the tray; only quit explicitly
  });
}
