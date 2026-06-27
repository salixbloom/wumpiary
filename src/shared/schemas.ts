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
const CssColor = z.string().max(128).catch('');

// The full set of plugin permissions — kept in sync with shared/plugins.ts
// (ALL_PERMISSIONS). Reused by the manifest schema and the setPluginPermission
// IPC tuple so there is one source of truth for the trust boundary.
const PluginPermissionEnum = z.enum([
  'accounts',
  'notifications',
  'discord-css',
  'discord-view',
  'network',
  'files',
  'clipboard',
  'hotkeys',
]);

// Lenient permission list used ONLY for the on-disk manifest. A manifest that
// names a permission this app build doesn't know (e.g. one added in a newer
// version, or removed/renamed across versions) must not brick the whole plugin
// — we drop the unknown entry (it grants nothing: default-deny) and keep the
// plugin working with its recognised permissions. The IPC tuple below keeps the
// STRICT enum, since a grant must always name a real permission.
const ManifestPermissions = z
  .array(z.string().max(40))
  .max(64)
  .default([])
  .transform((arr) => arr.filter((p): p is z.infer<typeof PluginPermissionEnum> => PluginPermissionEnum.options.includes(p as never)));

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
    pushToTalk: z
      .object({
        enabled: z.boolean(),
        key: z.string().min(1).max(64),
        ctrl: z.boolean(),
        alt: z.boolean(),
        shift: z.boolean(),
        meta: z.boolean(),
        activateSound: z.string().max(4096),
        deactivateSound: z.string().max(4096),
      })
      .partial()
      .strict(),
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
  showAccountMenu: z.tuple([AccountId]),
  pickSource: z.tuple([z.string().max(512).nullable()]),
  patchUi: z.tuple([UiPatch]),
  patchGlobal: z.tuple([GlobalPatch]),
  layoutSidebar: z.tuple([z.number().min(0).max(8192).nullable()]), // live sidebar footprint in px, or null to settle to config

  setOverlay: z.tuple([z.boolean()]),
  setWindowBackground: z.tuple([CssColor]),
  windowMinimize: z.tuple([]),
  windowToggleMaximize: z.tuple([]),
  windowClose: z.tuple([]),
  clearActivity: z.tuple([]),
  saveLogin: z.tuple([AccountId, z.string().max(320), z.string().max(512), z.string().min(1).max(256)]), // accountId, email, password, pin
  clearLogin: z.tuple([AccountId]),
  autofillLogin: z.tuple([AccountId, z.string().min(1).max(256)]), // accountId, pin
  setPluginEnabled: z.tuple([z.string().max(64), z.boolean()]),
  setPluginPermission: z.tuple([z.string().max(64), PluginPermissionEnum, z.boolean()]),
  reloadPlugins: z.tuple([]),
  openPluginsFolder: z.tuple([]),
  openPluginWindow: z.tuple([z.string().max(64)]),
  openPluginPanel: z.tuple([z.string().max(64)]),
  setPluginPanelBounds: z.tuple([z.string().max(64), z.number(), z.number(), z.number(), z.number()]),
  closePluginPanel: z.tuple([z.string().max(64)]),
  getPluginReadme: z.tuple([z.string().max(64)]),
} as const;

// Plugin manifest (manifest.json) — validated on disk, not over IPC, but kept
// here alongside the rest of the trust boundary.
// Relative file reference inside a plugin folder (the loader additionally
// guarantees it cannot escape the folder). No absolute paths or parent refs.
const PluginFile = z.string().min(1).max(200).regex(/^[^/\\][^\0]*$/, 'must be a relative path');

const PluginMetadataSchema = z
  .object({
    automationWarning: z.boolean().optional(),
    experimental: z.boolean().optional(),
    tags: z.array(z.string().max(40)).max(12).optional(),
    homepage: z.string().max(2048).optional(),
  })
  .strip();

const PluginUiSchema = z
  .object({
    panel: z.object({ entry: PluginFile, title: z.string().max(80).optional() }).strip().optional(),
    window: z
      .object({
        entry: PluginFile,
        title: z.string().max(80).optional(),
        width: z.number().int().min(160).max(4096).optional(),
        height: z.number().int().min(120).max(4096).optional(),
        frame: z.boolean().optional(),
      })
      .strip()
      .optional(),
  })
  .strip();

export const PluginManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be kebab-case').max(64),
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(40),
    description: z.string().max(500).optional(),
    author: z.string().max(120).optional(),
    entry: PluginFile.optional(),
    contentScript: PluginFile.optional(),
    permissions: ManifestPermissions,
    metadata: PluginMetadataSchema.optional(),
    ui: PluginUiSchema.optional(),
  })
  .strip();

// account-observer preload -> main (send). These come from the Discord page's
// renderer, so they are the least-trusted surface and must be clamped.
const Counter = z.number().int().min(0).max(1_000_000).catch(0);
export const ObserverSchemas = {
  obMetrics: z.tuple([
    z.object({ accountId: AccountId, unread: Counter, mentions: Counter }).strip(),
  ]),
  obTheme: z.tuple([
    z.object({
      accountId: AccountId,
      name: z.string().max(80).nullable().catch(null),
      appFrameBackground: CssColor,
      bg: CssColor,
      bg2: CssColor,
      bg3: CssColor,
      bgHover: CssColor,
      text: CssColor,
      textDim: CssColor,
      border: CssColor,
    }).strip(),
  ]),
  obConnection: z.tuple([
    z.object({ accountId: AccountId, state: ConnectionState }).strip(),
  ]),
  obCall: z.tuple([
    z.object({ accountId: AccountId, active: z.boolean() }).strip(),
  ]),
  // discord-view content script -> main: a broadcast to the plugin's other
  // contexts. Least-trusted surface (runs in the Discord page), so plugin id /
  // channel are clamped and `data` is treated as untrusted by recipients.
  obPluginMsg: z.tuple([
    z
      .object({
        accountId: AccountId,
        pluginId: z.string().max(64),
        channel: z.string().max(120),
        data: z.unknown(),
      })
      .strip(),
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
