# wumpiary

A home for many Wumpuses — a cross-platform desktop app that runs **multiple Discord accounts at once**, each in its own isolated, persistent session, so notifications from every account arrive together in real time.

It loads the Discord web client and is **observation only** — it never automates accounts or modifies Discord.

## Features

- **All accounts connected in the background** — every account keeps its gateway alive (`backgroundThrottling: false`) so it notifies even when not focused.
- **Right-hand collapsible sidebar** of "perches" — per-account avatar/nickname, unread + mention counters, and a connection status dot.
- **Per-account notifications** — mute, filter (all / mentions / DMs / none), snooze, hide previews, custom chime; account-tagged OS notifications.
- **Calls** — per-account policy (allow / muted / silent / block) + ringtone.
- **Account management** — add, quick sign-out (keeps the perch), forget (wipes the session), drag-to-reorder, nickname/colour/avatar.
- **Security** — PIN-gated encrypted vault (scrypt + AES-256-GCM, bound to the OS keychain where available), auto-lock on idle.
- **Resource controls** — only the active account is rendered; others stay connected but un-rendered. Opt-in / auto hibernation reclaims an account's RAM (it then stops notifying).
- **Conveniences** — global DND, tray with aggregate mention badge + quick switch, global hotkeys, themes, activity log, launch-at-login, crash/session recovery.
- **Plugins** — sandboxed, permission-gated plugins that extend wumpiary's own shell (events, notifications, cosmetic Discord CSS) without ever running code inside Discord. See [PLUGINS.md](PLUGINS.md).

## Resource & stability model

Validated in the Phase-0 spike (`SPIKE_FINDINGS.md`):

- `backgroundThrottling: false` is **mandatory** — without it a hidden account's heartbeat collapses to ~1/minute within ~90 s. With it, drift stays at ~2 ms indefinitely.
- **Un-rendering** non-active views (`setVisible(false)`) saves paint/GPU at zero stability cost.
- **Hibernation** (destroying the WebContents) is the only way to reclaim an account's RAM — so it is opt-in / auto-after-inactivity and clearly stops notifications.

## Develop / run

```bash
npm install
npm run dev        # electron-vite dev server with HMR
npm run build      # production build into out/
npm start          # preview the production build
npm run typecheck  # tsc --noEmit

npm run package:linux   # build a distributable (AppImage + deb) into dist/
npm run package:win     # NSIS installer
npm run package:mac     # dmg
npm run package:dir     # unpacked app only (fast, no installer)
```

> On a headless Linux box you can launch with `xvfb-run -a electron .` after `npm run build`, but the app is intended to be driven on a real desktop.

## Project layout

```
src/
  main/        # app lifecycle, accounts/sessions, vault, notifications, tray, hotkeys, IPC
  preload/     # chrome.ts (typed window.wumpiary bridge) + account-observer.ts (observe-only)
  renderer/    # React UI: sidebar, perches, settings, lock screen
  shared/      # types + IPC channel contracts
```

## Status

`v0.2.0` — feature-complete MVP: built, type-checked, IPC-validated, and packageable for Win/macOS/Linux. Intended for live testing on a real desktop. Automated tests are deferred — see PLAN.md §16 for the planned strategy, and [CHANGELOG.md](CHANGELOG.md) for release history.
