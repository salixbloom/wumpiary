// Zod schemas validating every inbound IPC payload in the main process
// (PLAN.md §11: "Validate every inbound payload in main with a schema; reject
// malformed messages"). Each schema is a z.tuple matching a handler's
// positional arguments, so the validated value can be spread straight into the
// handler with full type-safety. Kept in its own module so the renderer bundle
// never imports zod (it only needs the channel constants from ./ipc).

import { z } from 'zod';

// ---- primitives ----------------------------------------------------------
const Pin = z.string().min(1).max(256);
const AccountId = z.string().min(1).max(128);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const NotificationFilter = z.enum(['all', 'mentions', 'dms', 'mentions+dms', 'none']);
const CallPolicy = z.enum(['allow', 'muted', 'silent', 'block']);
const Theme = z.enum(['dark', 'light', 'system']);
const ConnectionState = z.enum([
  'connected', 'reconnecting', 'offline', 'hibernated', 'signed-out', 'loading',
]);
const NotifKind = z.enum(['message', 'mention', 'dm', 'call']);

// ---- composite payloads --------------------------------------------------
const AccountNotifPatch = z
  .object({
    muted: z.boolean(),
    filter: NotificationFilter,
    chime: z.string().max(4096),
    hidePreview: z.boolean(),
    snoozeUntil: z.number().int().nonnegative().nullable(),
  })
  .partial()
  .strict();

const CallPatch = z
  .object({ policy: CallPolicy, ringtone: z.string().max(4096) })
  .partial()
  .strict();

const AccountPatch = z
  .object({
    nickname: z.string().max(120),
    color: Hex,
    avatarOverride: z.string().max(2_000_000).nullable(), // data URL or path
    proxy: z.string().max(2048).nullable(),
    notifications: AccountNotifPatch,
    calls: CallPatch,
  })
  .partial()
  .strict();

const UiPatch = z
  .object({
    sidebarSide: z.enum(['right', 'left']),
    sidebarCollapsed: z.boolean(),
    sidebarWidth: z.number().int().min(64).max(1024),
    theme: Theme,
    accent: Hex,
  })
  .partial()
  .strict();

const GlobalPatch = z
  .object({
    dnd: z.boolean(),
    hidePreviews: z.boolean(),
    autoLaunch: z.boolean(),
    startMinimized: z.boolean(),
    autoLockMinutes: z.number().int().min(0).max(1440),
    autoHibernateMinutes: z.number().int().min(0).max(1440),
  })
  .partial()
  .strict();

// ---- per-channel argument tuples -----------------------------------------
// renderer -> main (invoke)
export const RendererSchemas = {
  getState: z.tuple([]),
  setupPin: z.tuple([Pin]),
  unlock: z.tuple([Pin]),
  lock: z.tuple([]),
  addAccount: z.tuple([]),
  signOut: z.tuple([AccountId]),
  forget: z.tuple([AccountId]),
  setActive: z.tuple([AccountId]),
  setHibernated: z.tuple([AccountId, z.boolean()]),
  reload: z.tuple([AccountId]),
  openDevtools: z.tuple([AccountId]),
  reorder: z.tuple([z.array(AccountId).max(256)]),
  updateAccount: z.tuple([AccountId, AccountPatch]),
  snooze: z.tuple([AccountId, z.number().int().nonnegative().nullable()]),
  patchUi: z.tuple([UiPatch]),
  patchGlobal: z.tuple([GlobalPatch]),
  setOverlay: z.tuple([z.boolean()]),
  clearActivity: z.tuple([]),
  setPluginEnabled: z.tuple([z.string().max(64), z.boolean()]),
  setPluginPermission: z.tuple([z.string().max(64), z.enum(['accounts', 'notifications', 'discord-css']), z.boolean()]),
  reloadPlugins: z.tuple([]),
  openPluginsFolder: z.tuple([]),
} as const;

// Plugin manifest (manifest.json) — validated on disk, not over IPC, but kept
// here alongside the rest of the trust boundary.
export const PluginManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be kebab-case').max(64),
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(40),
    description: z.string().max(500).optional(),
    author: z.string().max(120).optional(),
    entry: z.string().min(1).max(200),
    permissions: z.array(z.enum(['accounts', 'notifications', 'discord-css'])).max(8).default([]),
  })
  .strip();

// account-observer preload -> main (send). These come from the Discord page's
// renderer, so they are the least-trusted surface and must be clamped.
const Counter = z.number().int().min(0).max(1_000_000).catch(0);
export const ObserverSchemas = {
  obMetrics: z.tuple([
    z.object({ accountId: AccountId, unread: Counter, mentions: Counter }).strip(),
  ]),
  obConnection: z.tuple([
    z.object({ accountId: AccountId, state: ConnectionState }).strip(),
  ]),
  obNotification: z.tuple([
    z
      .object({
        accountId: AccountId,
        title: z.string().max(2000).catch(''),
        body: z.string().max(8000).catch(''),
        kind: NotifKind.catch('message'),
      })
      .strip(),
  ]),
} as const;
