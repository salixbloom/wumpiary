# Multi-Account Discord Wrapper - Development Plan

**Working title:** *Aviary* (placeholder - each account is a bird in its own perch)
**Document type:** Technical development plan / specification
**Status:** Draft v1

---

## 1. Overview

Aviary is a cross-platform desktop application that wraps the official Discord web client and runs **multiple accounts simultaneously**, each in its own isolated session, so that notifications from **every** logged-in account - main and alts - arrive in real time at the same time. This solves the core limitation of the official desktop client, which only keeps one account's live notification stream active at a time.

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
- **No automation, self-botting, token scraping, or API-level user-account manipulation.** The app loads the real web client and the user logs in normally. (See 10.)
- Not a Discord *mod* (no Vencord-style client patching). Customization lives in the wrapper shell, not inside Discord's code.
- Not attempting to reimplement Discord features (voice infra, etc.) - those come from the embedded web client.

---

## 3. The Core Technical Challenge (read this first)

The entire value of the app rests on one thing: **every account's gateway WebSocket connection must stay alive even when its tab is not focused.** If a backgrounded account's connection is suspended, its notifications stop - which defeats the purpose.

This creates a direct tension with the usual Electron optimization of hibernating/throttling background views:

- **`backgroundThrottling` must be disabled** on every account's web view. Chromium throttles timers in backgrounded/hidden renderers, which can stall the gateway's heartbeat and cause Discord to drop the connection. Disable it so heartbeats keep firing.
- **Views stay alive but can be un-rendered.** The connection lives in the renderer's JS context (the WebSocket), not in the pixels. We can hide a view (stop compositing/painting it) while keeping its `WebContents` alive and connected. This keeps RAM/CPU sane without killing notifications.
- **True hibernation must be opt-in and explicit.** A "hibernate this account" option is fine as a power-user/RAM-saving feature, but it must come with a clear warning: *hibernated accounts do not receive notifications.* Default is "stay connected in background."
- **Reconnection resilience.** Sleep/wake, network changes, and Discord-side disconnects happen. Each view should be monitored; on detected disconnect, reload or let Discord's own reconnect logic recover, and reflect connection state in the sidebar (e.g., a small dot per account: connected / reconnecting / offline).

This is the single most important design constraint and should be validated in a spike before anything else is built.

---

## 4. Architecture

### Process model (Electron)
```
ÚÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ Main Process (Node) ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ¿
³   App lifecycle, window management, tray                                         ³
³   Session/partition manager (one persistent partition per account)               ³
³   Secure store (encrypted tokens/config, OS keychain + PIN-derived key)          ³
³   Notification router (tag, mute, route, custom sound, privacy)                  ³
³   Global hotkeys, auto-launch, updater                                           ³
³   IPC hub                                                                         ³
ÀÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÂÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÂÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÙ
                ³                                                   ³
     ÚÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ¿                          ÚÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ¿
     ³  Sidebar / Chrome UI  ³  (renderer, your app UI) ³  Account View 1..N   ³
     ³  - right sidebar      ³                          ³  WebContentsView per ³
     ³  - tabs, counters     ³                          ³  account, isolated   ³
     ³  - settings panels    ³                          ³  partition:persist:  ³
     ³  - lock screen        ³                          ³  accountN            ³
     ÀÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÙ                          ³  loads discord.com/app³
                                                         ÀÄÄÄÄÄÄÄÄÄÄÂÄÄÄÄÄÄÄÄÄÄÄÙ
                                                                    ³ preload bridge
                                                          (observe unread/mentions,
                                                           intercept Notification,
                                                           report connection state)
```

### Key components
- **Account View** - one `WebContentsView` (modern replacement for `BrowserView`) per account, each assigned a unique persistent session partition (`partition: 'persist:acct-<uuid>'`). Loads `https://discord.com/app`. Isolated cookie jar + storage = independent login per view.
- **Preload bridge** - a small, read-only preload script injected into each account view. It does **not** modify Discord behavior; it only *observes* (unread counts, mention counts, title changes, the page's `Notification` calls, connection/online state) and relays them to the main process via IPC. Kept minimal to stay on the right side of "unmodified client."
- **Sidebar/Chrome renderer** - your own UI: the right-hand collapsible account rail, per-account context menus, settings, and the lock screen.
- **Notification router (main)** - receives notification events from preloads, applies per-account rules (mute, filter, custom sound, privacy redaction), and emits native OS notifications tagged with the originating account.
- **Secure store (main)** - encrypted persistence of config and any cached credentials, gated by master password/PIN (see 8).

---

## 5. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Electron** (latest LTS) | Needed for multiple isolated persistent sessions + native notifications + tray. |
| Account views | **`WebContentsView`** | Current API; `BrowserView` is deprecated. |
| UI framework | React + TypeScript (or Svelte) | For the sidebar/settings chrome only. |
| State | Zustand / Redux (lightweight) | App config, account list, counters, connection state. |
| Styling | Tailwind or CSS modules | Match Discord's dark aesthetic by default; light/system themes optional. |
| Secure storage | Electron **`safeStorage`** (OS keychain) + PIN-derived key (argon2id/scrypt) | Layered: OS keychain protects the vault key; PIN unlocks the session. |
| Config store | JSON via `electron-store` (non-secret) + encrypted blob (secret) | Separate secret vs non-secret data. |
| Packaging | electron-builder | Win/macOS/Linux installers + auto-update. |
| Updates | electron-updater | Signed releases. |

**Reference:** Ferdium is open-source and implements the multi-service-with-isolated-sessions pattern. Worth reading its repo for partition handling, notification bridging, and known Discord quirks (notably voice/RTC issues in wrappers - see 7).

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
- **Unread counter** (grey pill) and **mention counter** (red pill) - separate, because "12 unread" ? "2 @mentions." (See 7.)
- Muted / DND overlays where applicable.

### Account context menu (right-click on a perch)
- **Quick Sign Out** - signs the account out of Discord *but keeps it in the list* (perch remains, shown as "signed out," one-click to sign back in). Implemented by clearing the session's auth tokens/cookies for that partition without deleting the partition or its config entry.
- **Forget Account** - fully removes the account: deletes the partition (cookies/storage), its config entry, and any cached credentials. Confirmation required.
- Mute/unmute notifications ú Set custom chime ú Call settings ú Set nickname/color/avatar ú Hibernate/Wake ú Reload view ú Open in (devtools for debugging, behind a flag).

### Lock screen
- On launch (and optionally on idle/lock-hotkey), show a **master password / PIN** screen before any account view is created or unlocked. (See 8.)

---

## 7. Feature Specifications

### 7.1 Notifications (core)
- **Per-account silencing** - toggle to fully mute OS notifications and sounds from a specific account while it stays connected (so counters still update; you just aren't pinged). Right-click  Mute, or settings toggle.
- **Per-account custom chime** - assign a distinct notification sound per account (built-in pack + "browse for file" for custom WAV/MP3/OGG). Plays through the OS/Electron notification or a dedicated audio element on notification events. Lets you tell by ear which account got pinged.
- **Notification filtering (per account)** - choose what generates a ping: All messages ú Only @mentions ú Only DMs ú Only @mentions + DMs ú @everyone/@here on/off ú specific-server allowlist/denylist (stretch). Mirrors Discord's own granularity but at the wrapper level so it works across all accounts uniformly.
- **Account-tagged notifications** - every OS notification is labeled with which account it's for (e.g., "art alt - message from @user"), since that's the whole point.
- **Privacy / preview hiding** - option to suppress message content in OS notifications ("New message" only), global and per-account. Useful when screen-sharing or in public.
- **Snooze** - temporarily silence a specific account for 15m/1h/until-tomorrow, with auto-resume.
- **Counters** - per-tab unread + mention badges (see UI). Tray badge shows aggregate mention count across all accounts.

### 7.2 Calls / Voice
- **Per-account call policy:** Allow calls ú Notify-but-muted (popup, no ringtone) ú Silent (counter only, no popup, no sound) ú Block call notifications entirely.
- **Custom ringtone per account** (same mechanism as chimes).
- **Known risk:** voice/RTC in Electron wrappers can be flaky - there are documented cases of Discord voice failing to connect inside wrappers (e.g., Ferdium) while working in the official client. Plan to: (a) test WebRTC early, (b) ensure the embedded Chromium has needed codecs/permissions, (c) request mic/camera permissions correctly per session, and (d) document a fallback. Treat reliable voice as a **stretch goal**, not an MVP guarantee - notifications and text are the reliable core.

### 7.3 Account management
- **Add account** - creates a new partition + perch, opens a fresh Discord login.
- **Quick Sign Out** (keeps perch) and **Forget Account** (removes everything) - as specified in 6.
- **Reorder** - drag perches to reorder; order persists.
- **Groups/folders** (stretch) - collapse accounts into labeled groups (e.g., "Work," "Personal," "Alts").
- **Nicknames, color tags, custom avatars** for fast visual identification of similar-looking alts.
- **Per-account proxy** (stretch, privacy-relevant for alts) - route a specific account's traffic through a configured proxy so alts aren't trivially IP-correlated. Electron supports per-session proxy config. Document responsibly; this is for legitimate privacy, not ban evasion.

### 7.4 Security & fast sign-in
- **Master password / PIN unlock** - see 8 for the full security design. UX: set a PIN on first run; on launch, enter PIN to decrypt the vault and restore all sessions at once ("quick sign in").
- **Auto-lock** - lock after configurable idle time or via global hotkey; re-entry requires PIN.
- **Optional biometric unlock** (Touch ID / Windows Hello) layered on top of the keychain where available.

### 7.5 App-level conveniences ("anything else useful")
- **Global Focus / DND mode** - one switch silences *all* accounts; auto-schedule (e.g., work hours, sleep hours).
- **Tray integration** - minimize to tray, aggregate unread/mention badge, quick mute-all, quick account switch from tray menu.
- **Global hotkeys** - next/previous account, jump to account N, toggle sidebar, toggle DND, lock app.
- **Per-account status quick-set** (stretch) - set Online/Idle/DND/Invisible without opening that account's settings (driven via the web UI, observed-not-injected where possible).
- **Auto-launch on startup**, optionally start minimized to tray.
- **Themes** - dark (default, matches Discord) / light / follow-system; optional accent color.
- **Per-account zoom & spellcheck language.**
- **Connection health panel** - see every account's gateway state at a glance; manual reconnect button.
- **Config export/import** (excluding secrets) - portable setup; secrets never leave the keychain unencrypted.
- **Notification history / activity log** - a scrollable in-app log of recent notifications across all accounts (helpful when several fire at once).
- **"Mark all read" per account / all accounts** (where the web client exposes it).
- **Resource controls** - optional auto-hibernate after long inactivity (with the explicit "won't notify while hibernated" warning), and a RAM usage readout per account.
- **Crash/session recovery** - restore all views and the active account after a crash or restart.
- **First-run wizard** - set PIN, add first account, pick defaults.

---

## 8. Security Design (tokens, PIN, master password)

This is the most security-sensitive part, because "stay logged in + quick PIN sign-in" means persisting authentication material.

### What's actually stored
- Discord auth lives in each session partition's cookies/localStorage (managed by the Discord web client itself). We don't extract or hand-roll tokens.
- To support locking the app behind a PIN, the **partition data is encrypted at rest** and only mounted/decrypted after successful PIN entry.

### Layered key model
1. **OS keychain (`safeStorage`)** holds a randomly generated **vault key**. This ties decryption to the OS user account and hardware-backed storage where available.
2. **PIN/master password** is run through a slow KDF (**argon2id** or scrypt) to derive a second key. The vault key is wrapped (encrypted) by the PIN-derived key.
3. To unlock: enter PIN  derive key  unwrap vault key  decrypt config/session data  create account views. Wrong PIN ? decryptable.
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

- This design deliberately **loads the genuine, unmodified Discord web client** and has the user log in normally - multiple times in parallel, with isolated sessions. It does **not** automate accounts, inject tokens, or patch Discord's code. That places it much closer to "running Discord web in several browser profiles" than to a self-bot.
- Discord's ToS does restrict accessing the service via unofficial clients, so a wrapper is arguably one. In practice, wrappers of this kind (Ferdium, Rambox, etc.) have operated for years at scale, but this is tolerated, not officially endorsed. Document this clearly for users.
- The more realistic account-risk vector is **alt-account behavior** itself (mass-created alts, evasion, spam) tripping Discord's anti-abuse systems - that's about how accounts are used, independent of this app.
- **Design guardrails to stay clearly on the legitimate side:** preload scripts observe only (no behavior modification, no message automation), no token export, no bulk account creation features, and the proxy feature is framed and documented for privacy, not ban evasion.

---

## 11. Development Roadmap

### Phase 0 - Feasibility spike (most important)
- One Electron window, **two** account views with isolated persistent partitions, both logged into different accounts.
- Verify **both gateway connections stay alive while backgrounded** and both fire notifications. Confirm `backgroundThrottling: false` keeps heartbeats alive through sleep/wake and minimize.
- Prove out the preload notification interception + account tagging.
- **Gate:** if simultaneous background notifications don't work reliably, stop and solve this before building UI.

### Phase 1 - MVP
- Right-hand collapsible sidebar with perches.
- Add / Quick Sign Out (keep perch) / Forget Account.
- Per-account live unread + mention counters.
- Account-tagged native notifications.
- Per-account mute.
- Basic persistence of account list + layout.

### Phase 2 - Notification richness
- Per-account custom chimes + notification filtering (mentions/DMs/all).
- Privacy/preview hiding, snooze, global DND, tray badge + mute-all.
- Connection-health indicators + manual reconnect.

### Phase 3 - Security & sign-in
- Master password/PIN, encrypted vault, auto-lock, optional biometrics.
- "Quick sign in" restoring all sessions on unlock.

### Phase 4 - Calls & polish
- Per-account call policy + ringtones; WebRTC validation and fallbacks.
- Nicknames/colors/avatars, reorder, groups, themes, hotkeys, auto-launch, updater.

### Phase 5 - Power features (stretch)
- Per-account proxy, status quick-set, hibernation controls, activity log, config export/import, first-run wizard.

---

## 12. Open Questions / Decisions to Make
- **WebRTC/voice:** in-scope for v1 or explicitly deferred? (Recommend: defer reliability guarantees; text + notifications are the core promise.)
- **Updates to Discord's web app:** the client changes often; the preload's observation hooks (reading unread/mention counts, intercepting `Notification`) must be resilient and easy to patch. How brittle is acceptable, and what's the update cadence?
- **Custom-sound mechanism:** rely on the OS notification sound, or play audio ourselves on each notification event for full per-account control? (Latter gives more control but needs careful de-duplication.)
- **Counter source of truth:** scrape from the web UI/title, or infer from intercepted notification events? (Title/DOM is more accurate for totals; events are better for "what just happened.")
- **Wipe-after-failed-PIN:** include it at all? Default off, loud warning if on.
- **Distribution & code signing:** signing certs for Win/macOS, notarization on macOS.

---

## 13. Suggested Project Structure
```
aviary/
ÃÄ src/
³  ÃÄ main/                  # main process
³  ³  ÃÄ index.ts
³  ³  ÃÄ sessions.ts         # partition/session manager
³  ³  ÃÄ accounts.ts         # account lifecycle (add/signout/forget/hibernate)
³  ³  ÃÄ notifications.ts    # router: tag, mute, filter, sound, privacy
³  ³  ÃÄ vault.ts            # safeStorage + PIN KDF + encrypt/decrypt
³  ³  ÃÄ tray.ts
³  ³  ÃÄ hotkeys.ts
³  ³  ÀÄ updater.ts
³  ÃÄ preload/
³  ³  ÀÄ account-observer.ts # observe-only bridge injected per account view
³  ÃÄ renderer/              # sidebar/chrome UI (your app, not Discord)
³  ³  ÃÄ Sidebar/
³  ³  ÃÄ Settings/
³  ³  ÃÄ LockScreen/
³  ³  ÀÄ state/
³  ÀÄ shared/                # types, config schema, ipc channels
ÃÄ resources/                # sounds, icons
ÃÄ build/                    # electron-builder config, signing
ÀÄ package.json
```

---

## 14. Summary

The crux of the whole project is **3**: keeping every account's gateway connection alive in the background so notifications from all accounts land simultaneously. Everything else - the right-side collapsible sidebar, per-account mute/chime/call policies, quick sign-out that keeps the perch, forget-account, PIN-based quick sign-in, and per-tab counters - is well-trodden Electron UI and IPC work layered on top of that foundation. Validate the background-connection behavior first (Phase 0), then build outward. Studying Ferdium's open-source implementation will shortcut several of the trickier wrapper-specific problems, especially around notification bridging and Discord's web-client quirks.
