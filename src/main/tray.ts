import { app, Menu, Tray } from 'electron';
import { ConfigStore } from './config';
import { makeIcon } from './icon';

export interface TrayCallbacks {
  onShow: () => void;
  onToggleDnd: () => void;
  onLock: () => void;
  onQuit: () => void;
  onActivate: (id: string) => void;
}

/** Tray icon with aggregate mention badge and quick actions. */
export class AppTray {
  private tray: Tray;

  constructor(private cfg: ConfigStore, private cb: TrayCallbacks) {
    this.tray = new Tray(makeIcon(16, cfg.get().ui.accent));
    this.tray.setToolTip('wumpiary');
    this.tray.on('click', cb.onShow);
    this.refresh(0);
  }

  refresh(totalMentions: number) {
    const c = this.cfg.get();
    const accountItems = c.accountsOrder.map((id) => {
      const acc = c.accounts[id];
      return { label: acc.nickname, click: () => this.cb.onActivate(id) };
    });
    const menu = Menu.buildFromTemplate([
      { label: 'Open wumpiary', click: this.cb.onShow },
      { type: 'separator' },
      { label: c.global.dnd ? 'Disable Do Not Disturb' : 'Mute all (Do Not Disturb)', click: this.cb.onToggleDnd },
      { label: 'Accounts', enabled: accountItems.length > 0, submenu: accountItems.length ? accountItems : undefined },
      { type: 'separator' },
      { label: 'Lock', click: this.cb.onLock },
      { label: 'Quit', click: this.cb.onQuit },
    ]);
    this.tray.setContextMenu(menu);
    this.tray.setToolTip(totalMentions > 0 ? `wumpiary — ${totalMentions} mentions` : 'wumpiary');
    if (process.platform !== 'win32') app.badgeCount = totalMentions;
  }

  destroy() {
    this.tray.destroy();
  }
}
