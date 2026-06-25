# Wumpiary — Multi-Account Discord Wrapper · Development Plan

**Name:** *Wumpiary* (a home for many Wumpuses — each account is a Wumpus in its own perch)
**Document type:** Technical specification + development plan
**Status:** Draft v2 (expanded for execution)

---

## 1. Overview

Wumpiary is a cross-platform desktop application that wraps the official Discord web client and runs **multiple accounts simultaneously**, each in its own isolated session, so that notifications from **every** logged-in account — main and alts — arrive in real time at the same time. This solves the core limitation of the official desktop client, which only keeps one account's live notification stream active at a time.

The app presents accounts as tabs/perches in a **collapsible right-hand sidebar**, with rich per-account controls (notification silencing, custom chimes, call handling), fast and secure sign-in via a master password/PIN, and per-account unread/mention counters.

---

## 2. Goals and Non-Goals

### Goals
- Run N Discord accounts concurrently, each maintaining its own live gateway connection.
- Receive and surface notifications from all accounts at once, clearly tagged by source account.
- Provide granular per-account control over notifications, sounds, and calls.
- Keep accounts logged in persistently and let the user lock/unlock the app with a master password or PIN.
- Stay as close to the genuine, unmodified Discord web client as possible (load it, don't reimplement or inject into it).

### Non-Goals
- **No automation, self-botting, token scraping, or API-level user-account manipulation.** The app loads the real web client and the user logs in normally. (See §10.)
- Not a Discord *mod* (no Vencord-style client patching). Customization lives in the wrapper shell, not inside Discord's code.
- Not attempting to reimplement Discord features (voice infra, etc.) — those come from the embedded web client.

---

## 3. The Core Technical Challenge (read this first)

The entire value of the app rests on one thing: **every account's gateway WebSocket connection must stay alive even when its tab is not focused.** If a backgrounded account's connection is suspended, its notifications stop — which defeats the purpose.

This creates a direct tension with the usual Electron optimization of hibernating/throttling background views:

- **`backgroundThrottling` must be disabled** on every account's web view. Chromium throttles timers in backgrounded/hidden renderers, which can stall the gateway's heartbeat and cause Discord to drop the connection. Disable it so heartbeats keep firing.
- **Views stay alive but can be un-rendered.** The connection lives in the renderer's JS context (the WebSocket), not in the pixels. We can hide a view (stop compositing/painting it) while keeping its `WebContents` alive and connected. This keeps RAM/CPU sane without killing notifications.
- **True hibernation must be opt-in and explicit.** A "hibernate this account" option is fine as a power-user/RAM-saving feature, but it must come with a clear warning: *hibernated accounts do not receive notifications.* Default is "stay connected in background."
- **Reconnection resilience.** Sleep/wake, network changes, and Discord-side disconnects happen. Each view should be monitored; on detected disconnect, reload or let Discord's own reconnect logic recover, and reflect connection state in the sidebar (a small dot per account: connected / reconnecting / offline).

This is the single most important design constraint and **must be validated in a spike (Phase 0) before anything else is built.**

---

## 4. Architecture

### Process model (Electron)

```
+=====================================================================+
|                       Main Process (Node)                           |
|  App lifecycle, window management, tray                             |
|  Session/partition manager (one persistent partition per account)  |
|  Secure store (encrypted vault, OS keychain + PIN-derived key)     |
|  Notification router (tag, mute, route, custom sound, privacy)     |
|  Global hotkeys, auto-launch, updater                              |
|  IPC hub                                                            |
+=====================================================================+
            |                                       |
   +--------+-----------+               +-----------+----------------+
   | Sidebar / Chrome UI |               |   Account View 1..N        |
   | (renderer, app UI)  |               |   WebContentsView per      |
   |  - right sidebar    |               |   account, isolated        |
   |  - tabs, counters   |               |   partition: persist:      |
   |  - settings panels  |               |   acct-<uuid>              |
   |  - lock screen      |               |   loads discord.com/app    |
   +---------------------+               +-----------+----------------+
                                                     | preload bridge
                                          (observe unread/mentions,
                                           intercept Notification,
                                           report connection state)
```

### Key components
- **Account View** — one `WebContentsView` (modern replacement for `BrowserView`) per account, each assigned a unique persistent session partition (`partition: 'persist:acct-<uuid>'`). Loads `https://discord.com/app`. Isolated cookie jar + storage = independent login per view.
- **Preload bridge** — a small, read-only preload script injected into each account view. It does **not** modify Discord behavior; it only *observes* (unread counts, mention counts, title changes, the page's `Notification` calls, connection/online state) and relays them to the main process via IPC. Kept minimal to stay on the right side of "unmodified client."
- **Sidebar/Chrome renderer** — our own UI: the right-hand collapsible account rail, per-account context menus, settings, and the lock screen.
- **Notification router (main)** — receives notification events from preloads, applies per-account rules (mute, filter, custom sound, privacy redaction), and emits native OS notifications tagged with the originating account.
- **Secure store (main)** — encrypted persistence of config and any cached credentials, gated by master password/PIN (see §8).

---

## 5. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Electron** (latest stable) | Needed for multiple isolated persistent sessions + native notifications + tray. |
| Account views | **`WebContentsView`** | Current API; `BrowserView` is deprecated. |
| Language | **TypeScript** (strict) | Across main, preload, and renderer. |
| UI framework | **React + TypeScript** | For the sidebar/settings chrome only. |
| State | **Zustand** | Lightweight app config, account list, counters, connection state. |
| Styling | **Tailwind CSS** | Match Discord's dark aesthetic by default; light/system themes optional. |
| Secure storage | Electron **`safeStorage`** (OS keychain) + PIN-derived key (**argon2id**) | Layered: OS keychain protects the vault key; PIN unlocks the session. |
| Config store | **`electron-store`** (non-secret) + encrypted blob (secret) | Separate secret vs non-secret data. |
| Build/bundler | **Vite** + **electron-vite** | Fast HMR for renderer, sane main/preload builds. |
| Packaging | **electron-builder** | Win/macOS/Linux installers + auto-update. |
| Updates | **electron-updater** | Signed releases. |
| Testing | **Vitest** (unit) + **Playwright for Electron** (E2E) | See §16. |
| Lint/format | **ESLint** + **Prettier** | Enforced in CI and pre-commit. |

**Reference:** Ferdium is open-source and implements the multi-service-with-isolated-sessions pattern. Worth reading its repo for partition handling, notification bridging, and known Discord quirks (notably voice/RTC issues in wrappers — see §7.2).

---

## 6. UI / UX Design

### Layout
- **Right-hand sidebar** (per request), vertically listing accounts as perches. The active account's Discord view fills the rest of the window to the left.
- **Collapsible:** sidebar toggles between an expanded rail (avatar + name + counters + status dot) and a collapsed rail (avatar + small badge only). A persistent toggle button (chevron) and a global hotkey both collapse/expand. Width is draggable; collapsed/expanded state persists.
- **Active indicator:** highlighted perch + accent bar on the active account.
- **Status dot** per account: connected (green), reconnecting (amber), offline/hibernated (grey), notifications-muted (crossed-bell overlay).

### Per-account perch shows
- Avatar (with optional custom override image/color/initials for instant alt identification).
- Display label (defaults to Discord username; user-editable nickname so "main", "art alt", "mod acct" are distinguishable).
- **Unread counter** (grey pill) and **mention counter** (red pill) — separate, because "12 unread" ≠ "2 @mentions." (See §7.)
- Muted / DND overlays where applicable.

### Account context menu (right-click on a perch)
- **Quick Sign Out** — signs the account out of Discord *but keeps it in the list* (perch remains, shown as "signed out," one-click to sign back in). Implemented by clearing the session's auth tokens/cookies for that partition without deleting the partition or its config entry.
- **Forget Account** — fully removes the account: deletes the partition (cookies/storage), its config entry, and any cached credentials. Confirmation required.
- Mute/unmute notifications · Set custom chime · Call settings · Set nickname/color/avatar · Hibernate/Wake · Reload view · Open devtools (behind a flag).

### Lock screen
- On launch (and optionally on idle/lock-hotkey), show a **master password / PIN** screen before any account view is created or unlocked. (See §8.)

---

## 7. Feature Specifications

### 7.1 Notifications (core)
- **Per-account silencing** — toggle to fully mute OS notifications and sounds from a specific account while it stays connected (so counters still update; you just aren't pinged). Right-click → Mute, or settings toggle.
- **Per-account custom chime** — assign a distinct notification sound per account (built-in pack + "browse for file" for custom WAV/MP3/OGG). Plays through the OS/Electron notification or a dedicated audio element on notification events. Lets you tell by ear which account got pinged.
- **Notification filtering (per account)** — choose what generates a ping: All messages · Only @mentions · Only DMs · Only @mentions + DMs · @everyone/@here on/off · specific-server allowlist/denylist (stretch). Mirrors Discord's own granularity but at the wrapper level so it works across all accounts uniformly.
- **Account-tagged notifications** — every OS notification is labeled with which account it's for (e.g., "art alt — message from @user"), since that's the whole point.
- **Privacy / preview hiding** — option to suppress message content in OS notifications ("New message" only), global and per-account. Useful when screen-sharing or in public.
- **Snooze** — temporarily silence a specific account for 15m/1h/until-tomorrow, with auto-resume.
- **Counters** — per-tab unread + mention badges (see UI). Tray badge shows aggregate mention count across all accounts.

### 7.2 Calls / Voice
- **Per-account call policy:** Allow calls · Notify-but-muted (popup, no ringtone) · Silent (counter only, no popup, no sound) · Block call notifications entirely.
- **Custom ringtone per account** (same mechanism as chimes).
- **Known risk:** voice/RTC in Electron wrappers can be flaky — there are documented cases of Discord voice failing to connect inside wrappers (e.g., Ferdium) while working in the official client. Plan to: (a) test WebRTC early, (b) ensure the embedded Chromium has needed codecs/permissions, (c) request mic/camera permissions correctly per session, and (d) document a fallback. Treat reliable voice as a **stretch goal**, not an MVP guarantee — notifications and text are the reliable core.

### 7.3 Account management
- **Add account** — creates a new partition + perch, opens a fresh Discord login.
- **Quick Sign Out** (keeps perch) and **Forget Account** (removes everything) — as specified in §6.
- **Reorder** — drag perches to reorder; order persists.
- **Groups/folders** (stretch) — collapse accounts into labeled groups (e.g., "Work," "Personal," "Alts").
- **Nicknames, color tags, custom avatars** for fast visual identification of similar-looking alts.
- **Per-account proxy** (stretch, privacy-relevant for alts) — route a specific account's traffic through a configured proxy so alts aren't trivially IP-correlated. Electron supports per-session proxy config. Document responsibly; this is for legitimate privacy, not ban evasion.

### 7.4 Security & fast sign-in
- **Master password / PIN unlock** — see §8 for the full security design. UX: set a PIN on first run; on launch, enter PIN to decrypt the vault and restore all sessions at once ("quick sign in").
- **Auto-lock** — lock after configurable idle time or via global hotkey; re-entry requires PIN.
- **Optional biometric unlock** (Touch ID / Windows Hello) layered on top of the keychain where available.

### 7.5 App-level conveniences
- **Global Focus / DND mode** — one switch silences *all* accounts; auto-schedule (e.g., work hours, sleep hours).
- **Tray integration** — minimize to tray, aggregate unread/mention badge, quick mute-all, quick account switch from tray menu.
- **Global hotkeys** — next/previous account, jump to account N, toggle sidebar, toggle DND, lock app.
- **Per-account status quick-set** (stretch) — set Online/Idle/DND/Invisible without opening that account's settings (driven via the web UI, observed-not-injected where possible).
- **Auto-launch on startup**, optionally start minimized to tray.
- **Themes** — dark (default, matches Discord) / light / follow-system; optional accent color.
- **Per-account zoom & spellcheck language.**
- **Connection health panel** — see every account's gateway state at a glance; manual reconnect button.
- **Config export/import** (excluding secrets) — portable setup; secrets never leave the keychain unencrypted.
- **Notification history / activity log** — a scrollable in-app log of recent notifications across all accounts.
- **"Mark all read" per account / all accounts** (where the web client exposes it).
- **Resource controls** — optional auto-hibernate after long inactivity (with the explicit "won't notify while hibernated" warning), and a RAM usage readout per account.
- **Crash/session recovery** — restore all views and the active account after a crash or restart.
- **First-run wizard** — set PIN, add first account, pick defaults.

---

## 8. Security Design (tokens, PIN, master password)

This is the most security-sensitive part, because "stay logged in + quick PIN sign-in" means persisting authentication material.

### What's actually stored
- Discord auth lives in each session partition's cookies/localStorage (managed by the Discord web client itself). We don't extract or hand-roll tokens.
- To support locking the app behind a PIN, the **partition data is encrypted at rest** and only mounted/decrypted after successful PIN entry.

### Layered key model
1. **OS keychain (`safeStorage`)** holds a randomly generated **vault key**, tying decryption to the OS user account and hardware-backed storage where available.
2. **PIN/master password** runs through a slow KDF (**argon2id**) to derive a second key. The vault key is wrapped (encrypted) by the PIN-derived key.
3. To unlock: enter PIN → derive key → unwrap vault key → decrypt config/session data → create account views. Wrong PIN → not decryptable.
4. **Biometric** (optional) can substitute for PIN entry by releasing the keychain item via Touch ID / Windows Hello.

### Practices
- Rate-limit and back off on failed PIN attempts; optional wipe-after-N-failures (off by default, with strong warning).
- Never write tokens/credentials to plaintext logs or config.
- Encrypt the whole secret blob; keep non-secret prefs (theme, layout) separate and unencrypted for fast boot.
- Make the threat model explicit in docs: this protects against casual local access (someone opening your laptop), **not** a determined attacker with full disk access and your running OS session. Be honest about that.

---

## 9. Data Model (sketch)

```jsonc
// non-secret config (electron-store)
{
  "ui": { "sidebarSide": "right", "sidebarCollapsed": false, "sidebarWidth": 240, "theme": "dark" },
  "global": { "dnd": false, "dndSchedule": null, "hidePreviews": false, "autoLaunch": true },
  "accountsOrder": ["acct-uuid-1", "acct-uuid-2"],
  "accounts": {
    "acct-uuid-1": {
      "partition": "persist:acct-uuid-1",
      "nickname": "main",
      "color": "#5865F2",
      "avatarOverride": null,
      "signedIn": true,
      "hibernated": false,
      "notifications": {
        "muted": false,
        "filter": "mentions+dms",
        "chime": "default",          // or path to custom sound
        "hidePreview": false,
        "snoozeUntil": null
      },
      "calls": { "policy": "allow", "ringtone": "default" }, // allow|muted|silent|block
      "proxy": null
    }
  }
}
```
Secrets (wrapped vault key, encrypted session material) live in the encrypted vault, **never** in this file.

---

## 10. Terms of Service & Risk

- This design deliberately **loads the genuine, unmodified Discord web client** and has the user log in normally — multiple times in parallel, with isolated sessions. It does **not** automate accounts, inject tokens, or patch Discord's code. That places it much closer to "running Discord web in several browser profiles" than to a self-bot.
- Discord's ToS does restrict accessing the service via unofficial clients, so a wrapper is arguably one. In practice, wrappers of this kind (Ferdium, Rambox, etc.) have operated for years at scale, but this is tolerated, not officially endorsed. Document this clearly for users.
- The more realistic account-risk vector is **alt-account behavior** itself (mass-created alts, evasion, spam) tripping Discord's anti-abuse systems — independent of this app.
- **Design guardrails to stay clearly on the legitimate side:** preload scripts observe only (no behavior modification, no message automation), no token export, no bulk account creation features, and the proxy feature is framed and documented for privacy, not ban evasion.

---

## 11. IPC Contract

All cross-process communication goes through a typed, namespaced IPC layer defined in `src/shared/ipc.ts`. Channels are versioned and validated; the preload exposes a minimal, frozen `contextBridge` API (no raw `ipcRenderer`).

### Channel groups

| Direction | Channel | Payload | Purpose |
|---|---|---|---|
| preload → main | `account:metrics` | `{ accountId, unread, mentions, online }` | Observed counters + connection state. |
| preload → main | `account:notification` | `{ accountId, title, body, icon, tag }` | Intercepted `Notification` from Discord page. |
| preload → main | `account:connection` | `{ accountId, state }` | `connected \| reconnecting \| offline`. |
| renderer → main | `accounts:add` | `{}` → `{ accountId }` | Create partition + perch. |
| renderer → main | `accounts:signout` | `{ accountId }` | Clear auth cookies, keep perch. |
| renderer → main | `accounts:forget` | `{ accountId }` | Delete partition + config. |
| renderer → main | `accounts:reorder` | `{ order: string[] }` | Persist new order. |
| renderer → main | `accounts:setActive` | `{ accountId }` | Show/raise a view. |
| renderer → main | `accounts:hibernate` | `{ accountId, on }` | Suspend/resume a view. |
| renderer → main | `vault:unlock` | `{ pin }` → `{ ok }` | Derive key, unwrap vault. |
| renderer → main | `vault:setup` | `{ pin }` | First-run PIN setup. |
| renderer → main | `settings:patch` | `{ path, value }` | Update non-secret config. |
| main → renderer | `state:patch` | partial app state | Push counter/connection/state updates. |
| main → renderer | `app:locked` | `{}` | Force lock screen. |

### Rules
- **Validate every inbound payload** in main with a schema (zod); reject malformed messages.
- Preload exposes only `window.wumpiary` with explicit methods; never the full `ipcRenderer`.
- Renderer never touches Node APIs (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` where possible).

---

## 12. Git Workflow (Git Flow)

The project follows **Git Flow**. Day-to-day work happens on short-lived branches off `develop`; `main` only ever holds released, tagged code.

### Branch model
- **`main`** — production/released code only. Every commit is tagged with a version (`vX.Y.Z`). Never commit directly.
- **`develop`** — integration branch; the base for all feature work. Always buildable.
- **`feature/<short-name>`** — new work, branched from `develop`, merged back into `develop` via PR. Naming: `feature/sidebar-collapse`, `feature/vault-argon2id`.
- **`release/<version>`** — branched from `develop` when cutting a release; only stabilization/bugfix/version-bump commits. Merged into both `main` (tagged) and `develop`.
- **`hotfix/<version>`** — branched from `main` for urgent production fixes; merged into both `main` (tagged) and `develop`.
- **`bugfix/<short-name>`** — non-urgent fix branched from `develop`.

```
main      ──●────────────────────●──────────────●──   (tags: v0.1.0, v0.2.0, …)
             \                  / \            /
release       \           ●──●─/   \      ●──/
               \         /          \    /
develop  ──●────●──●──●─●────●──●──●──●──●──────────
            \  /    \      /
feature      ●●      ●●●●●
```

### Conventions
- **Branch off `develop`** for features; rebase on `develop` before opening a PR to keep history clean.
- **Commit messages:** Conventional Commits — `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`, `build:`, `ci:`. Scope optional, e.g. `feat(notifications): per-account chime`.
- **Do NOT add Claude/Anthropic (or any AI tool) as a commit co-author or trailer.** Commits are authored by the human contributor only.
- **PRs** target `develop` (or `main` for hotfixes), require green CI, and at least the Definition-of-Done checklist (§17) satisfied.
- **Releases** are cut via a `release/*` branch; `electron-builder` produces signed artifacts from the tag on `main`.
- The initial setup task includes initializing the `develop` branch and configuring branch protection on `main` and `develop`.

> Note: the repo currently sits on a `trunk` branch; the first setup task is to establish `main` + `develop` per Git Flow.

---

## 13. Development Environment & Tooling

### Prerequisites
- Node.js (current LTS) + a package manager (pnpm recommended for speed/disk).
- Platform build deps for `electron-builder` (e.g., Wine for Windows targets on Linux/macOS, code-signing tooling per OS).

### Repo bootstrapping (setup task)
- `electron-vite` scaffold with three entry points: `main`, `preload`, `renderer`.
- TypeScript strict mode, path aliases (`@main`, `@renderer`, `@shared`).
- ESLint (typescript-eslint + react hooks + electron security rules) + Prettier.
- Husky + lint-staged pre-commit hook: format, lint, typecheck staged files.
- Commitlint enforcing Conventional Commits.
- `.editorconfig`, `.nvmrc`.

### Scripts (package.json)
- `dev` — electron-vite dev with HMR.
- `build` — typecheck + bundle all three targets.
- `package` — electron-builder for the current OS.
- `package:all` — Win/macOS/Linux artifacts.
- `lint`, `format`, `typecheck`.
- `test`, `test:e2e`.

---

## 14. Dependencies (initial manifest sketch)

| Package | Role |
|---|---|
| `electron`, `electron-vite`, `electron-builder`, `electron-updater` | Shell, build, package, update. |
| `react`, `react-dom` | Sidebar/chrome UI. |
| `zustand` | App state. |
| `tailwindcss`, `postcss`, `autoprefixer` | Styling. |
| `electron-store` | Non-secret config persistence. |
| `argon2` (or `@node-rs/argon2`) | PIN KDF. |
| `zod` | IPC payload + config validation. |
| `typescript`, `eslint`, `prettier`, `vitest`, `@playwright/test` | Tooling/tests. |
| `husky`, `lint-staged`, `@commitlint/{cli,config-conventional}` | Git hygiene. |

(`safeStorage`, `Notification`, `Tray`, `globalShortcut`, `session` are Electron built-ins — no extra dep.)

---

## 15. Suggested Project Structure

```
wumpiary/
├─ src/
│  ├─ main/                  # main process
│  │  ├─ index.ts
│  │  ├─ sessions.ts         # partition/session manager
│  │  ├─ accounts.ts         # account lifecycle (add/signout/forget/hibernate)
│  │  ├─ notifications.ts    # router: tag, mute, filter, sound, privacy
│  │  ├─ vault.ts            # safeStorage + PIN KDF + encrypt/decrypt
│  │  ├─ tray.ts
│  │  ├─ hotkeys.ts
│  │  └─ updater.ts
│  ├─ preload/
│  │  └─ account-observer.ts # observe-only bridge injected per account view
│  ├─ renderer/              # sidebar/chrome UI (our app, not Discord)
│  │  ├─ Sidebar/
│  │  ├─ Settings/
│  │  ├─ LockScreen/
│  │  └─ state/
│  └─ shared/                # types, config schema, ipc channels
│     ├─ ipc.ts
│     └─ config.ts
├─ resources/                # sounds, icons
├─ build/                    # electron-builder config, signing
├─ tests/
│  ├─ unit/
│  └─ e2e/
├─ .github/workflows/        # CI
└─ package.json
```

---

## 16. Testing Strategy

| Layer | Tooling | Covers |
|---|---|---|
| **Unit** | Vitest | Vault crypto (KDF wrap/unwrap, wrong-PIN rejection), notification router rules (mute/filter/privacy/snooze), config schema validation, IPC payload validation, state reducers. |
| **Integration** | Vitest + Electron test harness | Session/partition isolation (two partitions don't share cookies), account add/signout/forget lifecycle, hibernate/wake. |
| **E2E** | Playwright for Electron | Launch app → lock screen → set/enter PIN → add account → view loads → counters/connection dots update → mute → reorder → quit/restore. |
| **Manual matrix** | Checklist per release | The things automation can't reliably cover (see below). |

### Manual test matrix (per release, all 3 OSes where possible)
- **Phase-0 invariant:** two backgrounded accounts both keep gateway alive and both fire notifications through minimize, sleep/wake, and network drop/restore.
- Native notification appears, is account-tagged, plays the correct per-account chime, respects mute/snooze/privacy.
- Tray badge reflects aggregate mentions; mute-all works.
- WebRTC/voice connect attempt (best-effort; documented if it fails).
- Auto-launch, auto-lock idle, biometric unlock where available.
- Crash recovery restores views + active account.

### Crypto/security testing
- Verify no secrets land in logs or `electron-store`.
- Verify wrong PIN never yields decryptable data; verify rate-limit/backoff.
- Run `electron` security checklist + an automated dependency audit in CI.

---

## 17. CI/CD & Definition of Done

### CI (GitHub Actions, on every PR to `develop`/`main`)
- `lint` + `typecheck` + `test` (unit/integration) on Linux.
- E2E smoke (Playwright) on at least Linux; full matrix (Win/macOS/Linux) on `release/*` and `main`.
- Dependency/security audit.
- Build verification (`build` must succeed) — packaging only on tags.

### CD (release)
- On a `vX.Y.Z` tag on `main`: `electron-builder` produces **signed** installers for Win/macOS/Linux, macOS notarized, and publishes to the update feed for `electron-updater`.
- Code-signing certs and notarization credentials stored as CI secrets, never in-repo.

### Definition of Done (per PR)
- [ ] Conventional-commit messages; branch follows Git Flow; no AI co-author trailers.
- [ ] Types pass (`typecheck`), lint clean, formatted.
- [ ] Unit/integration tests added or updated and green.
- [ ] Security rules respected (`contextIsolation`, validated IPC, no secrets logged).
- [ ] Manual smoke for the touched feature; Phase-0 invariant unbroken if views are involved.
- [ ] Docs/CHANGELOG updated where user-facing.

---

## 18. Development Roadmap (milestones, tasks, estimates)

Estimates are rough engineering-effort guides for a single developer, not commitments.

### Phase 0 — Feasibility spike (most important) · ~1 week
**Goal:** prove the core invariant before building anything else.
- [ ] Repo bootstrap (electron-vite, TS, lint, hooks), `main`/`develop` per Git Flow.
- [ ] One window, **two** `WebContentsView`s with isolated persistent partitions, both logged into different accounts.
- [ ] Verify both gateway connections stay alive while backgrounded; confirm `backgroundThrottling: false` keeps heartbeats alive through minimize and sleep/wake.
- [ ] Prove preload notification interception + account tagging.
- **GATE:** if simultaneous background notifications don't work reliably, stop and solve this before building UI. **Exit criterion:** documented evidence both accounts notify simultaneously across minimize + sleep/wake + network drop.

### Phase 1 — MVP · ~2–3 weeks
- [ ] Right-hand collapsible sidebar with perches (expand/collapse, drag-width, persisted).
- [ ] Add / Quick Sign Out (keep perch) / Forget Account (with confirm).
- [ ] Per-account live unread + mention counters from preload metrics.
- [ ] Account-tagged native notifications via the router.
- [ ] Per-account mute.
- [ ] Persistence of account list + layout; crash/restore of active account.
- **Exit criterion:** add 2+ accounts, get tagged notifications, mute one, restart and recover state.

### Phase 2 — Notification richness · ~2 weeks
- [ ] Per-account custom chimes + notification filtering (all/mentions/DMs/…).
- [ ] Privacy/preview hiding, snooze, global DND, tray badge + mute-all.
- [ ] Connection-health indicators + manual reconnect.
- **Exit criterion:** distinct per-account audio, filters honored, tray aggregate accurate.

### Phase 3 — Security & sign-in · ~2 weeks
- [ ] Master password/PIN, argon2id-wrapped vault, encrypted-at-rest session material.
- [ ] Lock screen, auto-lock idle/hotkey, optional biometrics.
- [ ] "Quick sign in" restoring all sessions on unlock; failed-attempt backoff.
- **Exit criterion:** wrong PIN never decrypts; correct PIN restores all views; auto-lock works.

### Phase 4 — Calls & polish · ~2–3 weeks
- [ ] Per-account call policy + ringtones; WebRTC validation and documented fallback.
- [ ] Nicknames/colors/avatars, reorder, groups (basic), themes, global hotkeys.
- [ ] Auto-launch, updater wired to signed releases.
- **Exit criterion:** first signed, auto-updating release candidate.

### Phase 5 — Power features (stretch) · ongoing
- [ ] Per-account proxy, status quick-set, hibernation controls + RAM readout.
- [ ] Activity log, config export/import, first-run wizard, per-account zoom/spellcheck.

---

## 19. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Background gateway connection dies when view hidden | Med | **Critical** | Phase-0 gate; `backgroundThrottling:false`; keep WebContents alive; reconnect monitor. |
| R2 | Discord web client DOM/`Notification` hooks break on a Discord update | High | High | Keep preload observe-only + minimal; centralize selectors; fast patch path; resilient fallbacks (title-based counters). |
| R3 | WebRTC/voice fails inside wrapper | Med | Med | Treat as stretch; test early; correct per-session permissions/codecs; document fallback. |
| R4 | Vault/crypto bug leaks or locks out users | Low | **Critical** | Heavy unit tests; conservative KDF params; recovery docs; never log secrets. |
| R5 | ToS friction / account flags | Med | Med | Observe-only design, no automation/bulk-create, clear user docs (§10). |
| R6 | Code-signing/notarization blocks distribution | Med | Med | Acquire certs early; CI secrets; test signed builds before GA. |
| R7 | High RAM/CPU with many live views | Med | Med | Un-render hidden views; opt-in hibernation; per-account RAM readout. |

---

## 20. Open Questions / Decisions to Make
- **WebRTC/voice:** in-scope for v1 or explicitly deferred? *(Recommendation: defer reliability guarantees; text + notifications are the core promise.)*
- **Discord web-app churn:** how brittle is acceptable for the observation hooks, and what's the patch cadence?
- **Custom-sound mechanism:** rely on the OS notification sound, or play audio ourselves per event (more control, needs de-duplication)?
- **Counter source of truth:** scrape from web UI/title (accurate totals) vs infer from intercepted events (better "what just happened")? *(Likely: title/DOM for totals, events for the activity log.)*
- **Wipe-after-failed-PIN:** include it at all? Default off, loud warning if on.
- **Distribution & code signing:** which certs, notarization timeline, update-feed hosting.

---

## 21. Summary

The crux of the whole project is **§3**: keeping every account's gateway connection alive in the background so notifications from all accounts land simultaneously. Everything else — the right-side collapsible sidebar, per-account mute/chime/call policies, quick sign-out that keeps the perch, forget-account, PIN-based quick sign-in, and per-tab counters — is well-trodden Electron UI and IPC work layered on top of that foundation.

Execution order: **validate Phase 0 first**, then build outward through MVP → notification richness → security → polish, on a Git Flow branching model with typed IPC, a tested vault, and signed releases. Studying Ferdium's open-source implementation will shortcut several of the trickier wrapper-specific problems, especially around notification bridging and Discord's web-client quirks.
