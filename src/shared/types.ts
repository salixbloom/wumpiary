// Shared types used across main, preload, and renderer.

import type { PluginInfo } from './plugins';

export type NotificationFilter = 'all' | 'mentions' | 'dms' | 'mentions+dms' | 'none';
export type CallPolicy = 'allow' | 'muted' | 'silent' | 'block';
export type Theme = 'dark' | 'light' | 'system';

export interface ShellTheme {
  name: string | null;
  appFrameBackground: string;
  bg: string;
  bg2: string;
  bg3: string;
  bgHover: string;
  text: string;
  textDim: string;
  border: string;
}

/** Connection/availability state shown as the per-account status dot. */
export type ConnectionState =
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'hibernated'
  | 'signed-out'
  | 'loading';

/** Best-effort classification the observer attaches to a notification. */
export type NotifKind = 'message' | 'mention' | 'dm' | 'call';

export interface AccountNotifSettings {
  muted: boolean;
  filter: NotificationFilter;
  chime: string; // 'default' or an absolute file path
  hidePreview: boolean;
  snoozeUntil: number | null; // epoch ms
}

export interface AccountConfig {
  id: string;
  partition: string;
  nickname: string;
  color: string;
  avatarOverride: string | null;
  signedIn: boolean;
  hibernated: boolean;
  notifications: AccountNotifSettings;
  calls: { policy: CallPolicy; ringtone: string };
  proxy: string | null;
}

export interface UiConfig {
  sidebarSide: 'right' | 'left';
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  theme: Theme;
  accent: string;
}

export interface GlobalConfig {
  dnd: boolean;
  hidePreviews: boolean;
  autoLaunch: boolean;
  startMinimized: boolean;
  autoLockMinutes: number; // 0 = off
  autoHibernateMinutes: number; // 0 = off
  pushToTalk: {
    enabled: boolean;
    key: string;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
    activateSound: string;
    deactivateSound: string;
  };
}

export type GlobalPatch = Partial<Omit<GlobalConfig, 'pushToTalk'>> & {
  pushToTalk?: Partial<GlobalConfig['pushToTalk']>;
};

export interface PushToTalkStatus {
  available: boolean;
  active: boolean;
  error?: string;
}

export interface AppConfig {
  ui: UiConfig;
  global: GlobalConfig;
  accountsOrder: string[];
  accounts: Record<string, AccountConfig>;
  lastActiveId: string | null;
}

/** Per-account live state (not persisted). */
export interface AccountRuntime {
  id: string;
  unread: number;
  mentions: number;
  connection: ConnectionState;
  inCall: boolean;
  /** Transient: a notification was just surfaced from here; cleared on focus. */
  notifying: boolean;
}

/** A screen or window offered in the screen-share picker. */
export interface ShareSource {
  id: string;
  name: string;
  type: 'screen' | 'window';
  thumbnail: string; // data URL
  appIcon: string | null; // data URL
}

export interface ActivityEntry {
  id: string;
  accountId: string;
  nickname: string;
  title: string;
  body: string;
  kind: NotifKind;
  at: number;
}

/** Full state snapshot pushed from main to the renderer. */
export interface AppState {
  hasVault: boolean; // a PIN has been configured
  locked: boolean;
  activeId: string | null;
  config: AppConfig;
  runtime: Record<string, AccountRuntime>;
  activity: ActivityEntry[];
  totalMentions: number;
  encryptionAvailable: boolean;
  plugins: PluginInfo[];
  /** Per-account saved-login presence, for the autofill UI. */
  savedLogins: Record<string, { email: boolean; password: boolean }>;
  /** Best-effort Discord theme tokens observed from the active account view. */
  shellTheme: ShellTheme | null;
  /** Native global key hook status for app-level push to talk. */
  pushToTalkStatus: PushToTalkStatus;
}

export type AccountPatch = Partial<
  Pick<AccountConfig, 'nickname' | 'color' | 'avatarOverride' | 'proxy'>
> & {
  notifications?: Partial<AccountNotifSettings>;
  calls?: Partial<AccountConfig['calls']>;
};

export const defaultAccountColors = [
  '#5865F2', '#3BA55D', '#FAA81A', '#ED4245', '#EB459E', '#9B59B6', '#1ABC9C', '#E67E22',
];

export function defaultConfig(): AppConfig {
  return {
    ui: { sidebarSide: 'right', sidebarCollapsed: false, sidebarWidth: 248, theme: 'dark', accent: '#5865F2' },
    global: {
      dnd: false,
      hidePreviews: false,
      autoLaunch: false,
      startMinimized: false,
      autoLockMinutes: 0,
      autoHibernateMinutes: 0,
      pushToTalk: {
        enabled: false,
        key: 'Space',
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
        activateSound: 'default',
        deactivateSound: 'default',
      },
    },
    accountsOrder: [],
    accounts: {},
    lastActiveId: null,
  };
}

export function newAccountConfig(id: string, nickname: string, color: string): AccountConfig {
  return {
    id,
    partition: `persist:acct-${id}`,
    nickname,
    color,
    avatarOverride: null,
    signedIn: false,
    hibernated: false,
    notifications: { muted: false, filter: 'mentions+dms', chime: 'default', hidePreview: false, snoozeUntil: null },
    calls: { policy: 'allow', ringtone: 'default' },
    proxy: null,
  };
}
