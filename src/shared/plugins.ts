// Plugin system contract shared across main, the plugin-host preload, the
// plugin window/panel runtime, the Discord-view content scripts, and the
// renderer. Plugins extend wumpiary's OWN shell (events, notifications, custom
// chimes, Discord cosmetic CSS, their own UI surfaces) and — only with the
// explicit, off-by-default `discord-view` permission — may run a content script
// inside the Discord web client.
//
// Trust model (unchanged in shape, wider in surface): plugin code always runs
// sandboxed with no Node access; any capability that exposes something the user
// would care about is gated by an explicit permission recorded in
// permissions.json AND re-checked in the main process before it happens.

/** Capabilities a plugin can request. Each is user-sensitive and therefore
 *  permission-gated; storage, logging and intra-plugin messaging are always
 *  available. */
export type PluginPermission =
  | 'accounts'
  | 'notifications'
  | 'discord-css'
  | 'discord-view'
  | 'network'
  | 'files'
  | 'clipboard'
  | 'hotkeys';

export const ALL_PERMISSIONS: PluginPermission[] = [
  'accounts',
  'notifications',
  'discord-css',
  'discord-view',
  'network',
  'files',
  'clipboard',
  'hotkeys',
];

export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  accounts: 'Read your accounts — nicknames, unread/mention counts, connection state',
  notifications: 'See notification content and post its own notifications',
  'discord-css': 'Apply custom (cosmetic) CSS to the Discord views',
  'discord-view':
    'Run a content script INSIDE the Discord web client — read, hide or extract page content and simulate input (type/send/click). The one capability that writes to Discord.',
  network: 'Make network requests, and connect from its own plugin window (e.g. streaming, P2P)',
  files: 'Open native Save/Open dialogs to read and write files you choose',
  clipboard: 'Read from and write to your clipboard',
  hotkeys: 'Register global keyboard shortcuts',
};

/** Permissions considered especially powerful — surfaced with a caution note. */
export const HIGH_TRUST_PERMISSIONS: PluginPermission[] = ['discord-view'];

/** Display-only manifest metadata, rendered as badges in Settings → Plugins. */
export interface PluginMetadata {
  /** Shows a prominent warning badge about Discord account-automation risk. */
  automationWarning?: boolean;
  /** Marks the plugin as experimental / may be unstable. */
  experimental?: boolean;
  /** Free-form category chips. */
  tags?: string[];
  /** Optional homepage / docs link. */
  homepage?: string;
}

/** A UI surface a plugin can declare. `entry` is an HTML file in the plugin folder. */
export interface PluginUiSurface {
  entry: string;
  title?: string;
}

export interface PluginWindowSurface extends PluginUiSurface {
  width?: number;
  height?: number;
  /** Draw the OS window frame (default false → frameless). */
  frame?: boolean;
}

export interface PluginUi {
  /** A panel rendered inside the wumpiary window. */
  panel?: PluginUiSurface;
  /** A standalone (optionally frameless) window. */
  window?: PluginWindowSurface;
}

export interface PluginManifest {
  id: string; // unique, kebab-case; must match the folder name
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Headless entry JS (event handlers, lifecycle), relative to the folder. Optional for pure-UI plugins. */
  entry?: string;
  /** Content script injected into Discord views, relative to the folder. Requires `discord-view`. */
  contentScript?: string;
  permissions: PluginPermission[];
  metadata?: PluginMetadata;
  ui?: PluginUi;
}

/** Per-plugin info surfaced to the renderer (Settings → Plugins). */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  error: string | null; // manifest/load error, if any
  permissions: { name: PluginPermission; granted: boolean }[];
  metadata: PluginMetadata;
  /** Which UI surfaces this plugin declares (so the renderer can offer open/toggle controls). */
  ui: { hasPanel: boolean; panelTitle?: string; hasWindow: boolean; windowTitle?: string; hasReadme: boolean };
}

/** Exact copy users must see for the account-automation warning badge. */
export const AUTOMATION_WARNING_TEXT =
  'Account automation is strictly prohibited by Discord and can result in permanent account suspension, use this plugin responsibly.';

/** A sanitized account view handed to plugins holding the `accounts` permission. */
export interface PluginAccount {
  id: string;
  nickname: string;
  color: string;
  connection: string;
  unread: number;
  mentions: number;
  hibernated: boolean;
  signedIn: boolean;
}

/** Notification payload handed to plugins holding the `notifications` permission. */
export interface PluginNotification {
  accountId: string;
  nickname: string;
  title: string;
  body: string;
  kind: string;
}
