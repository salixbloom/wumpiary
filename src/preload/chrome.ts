import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type { AccountPatch, AppState, GlobalPatch, ShareSource, UiConfig } from '../shared/types';
import type { PluginPermission } from '../shared/plugins';

export interface UnlockResult {
  ok: boolean;
  waitMs?: number;
  attempts?: number;
}

// The only surface the renderer sees. No raw ipcRenderer is exposed.
const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC.getState),
  setupPin: (pin: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.setupPin, pin),
  unlock: (pin: string): Promise<UnlockResult> => ipcRenderer.invoke(IPC.unlock, pin),
  lock: (): Promise<unknown> => ipcRenderer.invoke(IPC.lock),

  addAccount: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.addAccount),
  signOut: (id: string) => ipcRenderer.invoke(IPC.signOut, id),
  forget: (id: string) => ipcRenderer.invoke(IPC.forget, id),
  setActive: (id: string) => ipcRenderer.invoke(IPC.setActive, id),
  setHibernated: (id: string, on: boolean) => ipcRenderer.invoke(IPC.setHibernated, id, on),
  reload: (id: string) => ipcRenderer.invoke(IPC.reload, id),
  openDevtools: (id: string) => ipcRenderer.invoke(IPC.openDevtools, id),
  reorder: (order: string[]) => ipcRenderer.invoke(IPC.reorder, order),
  updateAccount: (id: string, patch: AccountPatch) => ipcRenderer.invoke(IPC.updateAccount, id, patch),
  snooze: (id: string, until: number | null) => ipcRenderer.invoke(IPC.snooze, id, until),
  showAccountMenu: (id: string) => ipcRenderer.invoke(IPC.showAccountMenu, id),
  pickSource: (id: string | null) => ipcRenderer.invoke(IPC.pickSource, id),

  patchUi: (patch: Partial<UiConfig>) => ipcRenderer.invoke(IPC.patchUi, patch),
  patchGlobal: (patch: GlobalPatch) => ipcRenderer.invoke(IPC.patchGlobal, patch),
  setOverlay: (on: boolean) => ipcRenderer.invoke(IPC.setOverlay, on),
  setWindowBackground: (color: string) => ipcRenderer.invoke(IPC.setWindowBackground, color),
  minimizeWindow: () => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximizeWindow: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
  closeWindow: () => ipcRenderer.invoke(IPC.windowClose),
  clearActivity: () => ipcRenderer.invoke(IPC.clearActivity),

  saveLogin: (id: string, email: string, password: string, pin: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.saveLogin, id, email, password, pin),
  clearLogin: (id: string) => ipcRenderer.invoke(IPC.clearLogin, id),
  autofillLogin: (id: string, pin: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.autofillLogin, id, pin),

  setPluginEnabled: (id: string, on: boolean) => ipcRenderer.invoke(IPC.setPluginEnabled, id, on),
  setPluginPermission: (id: string, perm: PluginPermission, granted: boolean) => ipcRenderer.invoke(IPC.setPluginPermission, id, perm, granted),
  reloadPlugins: () => ipcRenderer.invoke(IPC.reloadPlugins),
  openPluginsFolder: () => ipcRenderer.invoke(IPC.openPluginsFolder),
  openPluginWindow: (id: string) => ipcRenderer.invoke(IPC.openPluginWindow, id),
  openPluginPanel: (id: string) => ipcRenderer.invoke(IPC.openPluginPanel, id),
  setPluginPanelBounds: (id: string, x: number, y: number, w: number, h: number) => ipcRenderer.invoke(IPC.setPluginPanelBounds, id, x, y, w, h),
  closePluginPanel: (id: string) => ipcRenderer.invoke(IPC.closePluginPanel, id),
  getPluginReadme: (id: string): Promise<string | null> => ipcRenderer.invoke(IPC.getPluginReadme, id),

  onState: (cb: (s: AppState) => void): (() => void) => {
    const l = (_e: unknown, s: AppState) => cb(s);
    ipcRenderer.on(IPC.stateChanged, l);
    return () => ipcRenderer.removeListener(IPC.stateChanged, l);
  },
  onPlayChime: (cb: (p: { accountId: string; chime: string }) => void): (() => void) => {
    const l = (_e: unknown, p: { accountId: string; chime: string }) => cb(p);
    ipcRenderer.on(IPC.playChime, l);
    return () => ipcRenderer.removeListener(IPC.playChime, l);
  },
  onPlaySound: (cb: (p: { sound: string }) => void): (() => void) => {
    const l = (_e: unknown, p: { sound: string }) => cb(p);
    ipcRenderer.on(IPC.playSound, l);
    return () => ipcRenderer.removeListener(IPC.playSound, l);
  },
  onPromptAutofill: (cb: (p: { accountId: string }) => void): (() => void) => {
    const l = (_e: unknown, p: { accountId: string }) => cb(p);
    ipcRenderer.on(IPC.promptAutofill, l);
    return () => ipcRenderer.removeListener(IPC.promptAutofill, l);
  },
  onOpenAccountSettings: (cb: (p: { accountId: string }) => void): (() => void) => {
    const l = (_e: unknown, p: { accountId: string }) => cb(p);
    ipcRenderer.on(IPC.openAccountSettings, l);
    return () => ipcRenderer.removeListener(IPC.openAccountSettings, l);
  },
  onShowSourcePicker: (cb: (p: { sources: ShareSource[] }) => void): (() => void) => {
    const l = (_e: unknown, p: { sources: ShareSource[] }) => cb(p);
    ipcRenderer.on(IPC.showSourcePicker, l);
    return () => ipcRenderer.removeListener(IPC.showSourcePicker, l);
  },
};

export type WumpiaryApi = typeof api;

contextBridge.exposeInMainWorld('wumpiary', api);
