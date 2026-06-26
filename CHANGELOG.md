# Changelog

All notable changes to wumpiary are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
semantic versioning.

## [0.2.0] — unreleased

### Added
- **Plugin system** — sandboxed, permission-gated plugins (folder packages with
  `manifest.json`) that extend wumpiary's own shell: subscribe to notification
  and account events, post notifications, persist small state, and apply
  cosmetic CSS to the Discord views. Plugins run with no Node and no network and
  can never run code inside the Discord client. Permissions (`accounts`,
  `notifications`, `discord-css`) are granted per-plugin in Settings → Plugins
  and stored in `permissions.json`. Authoring guide in `PLUGINS.md`, example in
  `examples/plugins/loud-mentions/`.
- **Packaging** — `electron-builder` config and `package:*` scripts producing
  AppImage/deb, NSIS, and dmg artifacts. Dormant `electron-updater` wiring,
  ready to activate once a release feed is configured.
- **IPC validation** — every inbound IPC payload is validated against a zod
  schema in the main process (PLAN.md §11); malformed messages are rejected.

### Fixed
- Blank window on WSLg caused by a GPU-process init failure — fall back to
  software compositing on WSL (`disableHardwareAcceleration`).

## [0.1.1] — 2026-06-25

### Fixed
- Vault PIN setup/unlock failing with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` — raise
  scrypt `maxmem` above the default 32 MB ceiling.
- Blank page in dev from a static Content-Security-Policy meta tag blocking the
  React-Refresh preamble; CSP is now applied as a production-only header.

## [0.1.0] — 2026-06-25

### Added
- First implementation of the multi-account Discord wrapper: isolated
  persistent sessions per account with `backgroundThrottling: false` so every
  account's gateway stays alive in the background; right-hand collapsible
  sidebar; per-account notifications (mute/filter/snooze/privacy/custom chime),
  call policies, account tagging; add / quick sign-out / forget / reorder;
  PIN-gated encrypted vault (scrypt + AES-256-GCM + OS keychain); tray, global
  hotkeys, global DND, activity log; opt-in / auto hibernation; crash/session
  recovery.
- Phase-0 resource & stability spike (`SPIKE_FINDINGS.md`) validating the
  background-connection invariant.
