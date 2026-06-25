import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import * as path from 'path';
import { ConfigStore } from './config';
import { Vault } from './vault';
import { AccountManager } from './accounts';
import { NotificationRouter, ObserverNotification } from './notifications';
import { AppTray } from './tray';
import { registerHotkeys, unregisterHotkeys } from './hotkeys';
import { IPC } from '../shared/ipc';
import { AccountPatch, AccountRuntime, ActivityEntry, AppState, ConnectionState, GlobalConfig, UiConfig } from '../shared/types';

class AppController {
  private cfg = new ConfigStore();
  private vault = new Vault();
  private win!: BrowserWindow;
  private accounts!: AccountManager;
  private router!: NotificationRouter;
  private tray?: AppTray;

  private locked = true;
  private runtime: Record<string, AccountRuntime> = {};
  private activity: ActivityEntry[] = [];
  private failed = 0;
  private lockoutUntil = 0;
  private isQuitting = false;
  private stateTimer: NodeJS.Timeout | null = null;

  start() {
    this.createWindow();
    this.accounts = new AccountManager(this.win, path.join(__dirname, '../preload/account-observer.js'), this.cfg, (id, patch) => this.onRuntime(id, patch));
    this.router = new NotificationRouter(
      this.cfg,
      (id) => this.activate(id),
      (id, chime) => this.win.webContents.send(IPC.playChime, { accountId: id, chime }),
      (entry) => { this.activity.unshift(entry); this.activity = this.activity.slice(0, 200); this.scheduleState(); },
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

  private createWindow() {
    this.win = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 860,
      minHeight: 560,
      show: false,
      backgroundColor: '#1e1f22',
      title: 'wumpiary',
      webPreferences: {
        preload: path.join(__dirname, '../preload/chrome.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });

    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl) this.win.loadURL(devUrl);
    else this.win.loadFile(path.join(__dirname, '../renderer/index.html')).catch((e) => console.error('[renderer] load failed', e));

    this.win.webContents.on('console-message', (_e, level, msg) => {
      if (level >= 2) console.warn('[renderer]', msg);
    });

    this.win.on('ready-to-show', () => {
      if (!this.cfg.get().global.startMinimized) this.win.show();
    });
    this.win.on('resize', () => this.accounts.layout());
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
      this.runtime[id] = { id, unread: 0, mentions: 0, connection: hib ? 'hibernated' : 'offline' };
    }
    return this.runtime[id];
  }

  private onRuntime(id: string, patch: Partial<AccountRuntime>) {
    Object.assign(this.ensureRuntime(id), patch);
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
    };
  }

  private scheduleState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      const s = this.buildState();
      this.win.webContents.send(IPC.stateChanged, s);
      this.tray?.refresh(s.totalMentions);
    }, 60);
  }

  // ---- lifecycle actions -------------------------------------------------
  private afterUnlock() {
    this.locked = false;
    this.accounts.init();
    this.accounts.setOverlay(false);
    this.applyGlobal();
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
    this.scheduleState();
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

  private applyGlobal() {
    const g = this.cfg.get().global;
    app.setLoginItemSettings({ openAtLogin: g.autoLaunch, openAsHidden: g.startMinimized });
  }

  private patchUi(patch: Partial<UiConfig>) {
    this.cfg.update((c) => Object.assign(c.ui, patch));
    this.accounts?.layout();
    this.scheduleState();
  }

  private patchGlobal(patch: Partial<GlobalConfig>) {
    this.cfg.update((c) => Object.assign(c.global, patch));
    this.applyGlobal();
    this.scheduleState();
  }

  // ---- IPC ---------------------------------------------------------------
  private registerIpc() {
    ipcMain.handle(IPC.getState, () => this.buildState());

    ipcMain.handle(IPC.setupPin, (_e, pin: string) => {
      if (this.vault.hasVault) return { ok: false };
      this.vault.setup(pin);
      this.afterUnlock();
      return { ok: true };
    });

    ipcMain.handle(IPC.unlock, (_e, pin: string) => {
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

    ipcMain.handle(IPC.lock, () => { this.lock(); return { ok: true }; });

    const guard = <T>(fn: () => T) => (this.locked ? undefined : fn());

    ipcMain.handle(IPC.addAccount, () => guard(() => this.accounts.add()));
    ipcMain.handle(IPC.signOut, (_e, id: string) => guard(() => this.accounts.signOut(id)));
    ipcMain.handle(IPC.forget, (_e, id: string) => guard(() => this.accounts.forget(id)));
    ipcMain.handle(IPC.setActive, (_e, id: string) => guard(() => this.activate(id)));
    ipcMain.handle(IPC.setHibernated, (_e, id: string, on: boolean) => guard(() => { this.accounts.setHibernated(id, on); this.scheduleState(); }));
    ipcMain.handle(IPC.reload, (_e, id: string) => guard(() => this.accounts.reload(id)));
    ipcMain.handle(IPC.openDevtools, (_e, id: string) => guard(() => this.accounts.openDevtools(id)));

    ipcMain.handle(IPC.reorder, (_e, order: string[]) => guard(() => {
      this.cfg.update((c) => { c.accountsOrder = order.filter((id) => c.accounts[id]); });
      this.scheduleState();
    }));

    ipcMain.handle(IPC.updateAccount, (_e, id: string, patch: AccountPatch) => guard(() => {
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
      this.scheduleState();
    }));

    ipcMain.handle(IPC.snooze, (_e, id: string, until: number | null) => guard(() => {
      this.cfg.update((c) => { if (c.accounts[id]) c.accounts[id].notifications.snoozeUntil = until; });
      this.scheduleState();
    }));

    ipcMain.handle(IPC.patchUi, (_e, patch: Partial<UiConfig>) => guard(() => this.patchUi(patch)));
    ipcMain.handle(IPC.patchGlobal, (_e, patch: Partial<GlobalConfig>) => guard(() => this.patchGlobal(patch)));
    ipcMain.handle(IPC.setOverlay, (_e, on: boolean) => guard(() => this.accounts.setOverlay(on)));
    ipcMain.handle(IPC.clearActivity, () => guard(() => { this.activity = []; this.scheduleState(); }));

    // observe-only events from account views
    ipcMain.on(IPC.obMetrics, (_e, p: { accountId: string; unread: number; mentions: number }) => {
      this.onRuntime(p.accountId, { unread: p.unread, mentions: p.mentions });
    });
    ipcMain.on(IPC.obConnection, (_e, p: { accountId: string; state: ConnectionState }) => {
      this.accounts.setConnection(p.accountId, p.state);
    });
    ipcMain.on(IPC.obNotification, (_e, p: ObserverNotification) => this.router.handle(p));
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
    this.cfg.flush();
    this.accounts?.destroyAll();
    this.tray?.destroy();
  }
}

// ---- bootstrap -----------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const controller = new AppController();
  app.on('second-instance', () => controller.showWindow());
  app.whenReady().then(() => {
    controller.start();
    app.on('activate', () => controller.showWindow());
  });
  app.on('before-quit', () => controller.shutdown());
  app.on('window-all-closed', () => {
    // we live in the tray; only quit explicitly
  });
}
