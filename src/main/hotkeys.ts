import { globalShortcut } from 'electron';

export interface HotkeyCallbacks {
  nextAccount: () => void;
  prevAccount: () => void;
  toggleSidebar: () => void;
  toggleDnd: () => void;
  lock: () => void;
}

export function registerHotkeys(cb: HotkeyCallbacks) {
  const map: Record<string, () => void> = {
    'CommandOrControl+Shift+Right': cb.nextAccount,
    'CommandOrControl+Shift+Left': cb.prevAccount,
    'CommandOrControl+Shift+B': cb.toggleSidebar,
    'CommandOrControl+Shift+D': cb.toggleDnd,
    'CommandOrControl+Shift+L': cb.lock,
  };
  for (const [accel, fn] of Object.entries(map)) {
    try {
      globalShortcut.register(accel, fn);
    } catch {
      /* a DE may reserve the combo; ignore */
    }
  }
}

export function unregisterHotkeys() {
  globalShortcut.unregisterAll();
}
