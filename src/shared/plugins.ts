// Plugin system contract shared across main, the plugin-host preload, and the
// renderer. Plugins extend wumpiary's OWN shell (events, notifications, custom
// chimes, Discord cosmetic CSS) — they NEVER get to run code inside the Discord
// web client (observe-only principle, PLAN.md §10). They run sandboxed with no
// Node/network, and any capability that exposes something the user would care
// about is gated by an explicit permission recorded in permissions.json.

/** Capabilities a plugin can request. Only these three are user-sensitive and
 *  therefore permission-gated; storage + logging are always available. */
export type PluginPermission = 'accounts' | 'notifications' | 'discord-css';

export const ALL_PERMISSIONS: PluginPermission[] = ['accounts', 'notifications', 'discord-css'];

export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  accounts: 'Read your accounts — nicknames, unread/mention counts, connection state',
  notifications: 'See notification content and post its own notifications',
  'discord-css': 'Apply custom (cosmetic) CSS to the Discord views',
};

export interface PluginManifest {
  id: string; // unique, kebab-case; must match the folder name
  name: string;
  version: string;
  description?: string;
  author?: string;
  entry: string; // entry JS file, relative to the plugin folder
  permissions: PluginPermission[];
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
}

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
