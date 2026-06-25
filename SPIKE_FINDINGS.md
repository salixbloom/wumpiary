# Phase 0 Spike — Resource & Stability Findings

**Branch:** `feature/phase0-resource-spike`
**Setup:** Electron (WebContentsView ×5, isolated partitions), each loading a synthetic "heavy" page (continuous canvas repaint + timer-driven CPU load + ~40 MB retained heap). An observe-only preload runs a 1 s "heartbeat" interval in the renderer event loop — the same place a Discord gateway heartbeat lives — and reports tick drift to the main process. Metrics from `app.getAppMetrics()`.
**Environment caveat:** headless Linux/WSL under Xvfb with **software rendering**. JS-CPU, RAM, process count, and timer/throttling behavior are representative; **GPU/compositing/paint savings are NOT** and must be re-measured on a real GPU desktop.

---

## 1. The core gate: does a backgrounded account stay connected? ✅ PASS

7-minute hold with 4 of 5 views hidden, tracking heartbeat drift:

| `backgroundThrottling` | Beats in 420 s (expected 420) | Max drift | Verdict |
|---|---|---|---|
| **`true`** (Chromium default) | ~62 (≈ **1 beat/minute**) | **320,825 ms** | ❌ HEARTBEAT STALLED |
| **`false`** (our config) | **420** | **2 ms** (flat) | ✅ HEARTBEAT SURVIVES |

With throttling on, intensive timer throttling clamped the hidden renderer to ~1 wake/minute **within ~90 seconds** (faster than the often-quoted 5-minute threshold for a plain page) and drift grew without bound. With throttling off, the heartbeat was indistinguishable from a foreground tab for the entire hold.

**Conclusion:** `webPreferences.backgroundThrottling: false` on every account view is **mandatory and sufficient** for the keep-connected-in-background requirement (§3 of PLAN.md). This is the single most important setting in the app.

---

## 2. Resource levers, measured (5 views)

| Lever | How | CPU | Renderer RAM | Procs | Effect on heartbeat |
|---|---|---|---|---|---|
| A. baseline (all active) | — | 2.6% | 827 MB | 8 | fine |
| B. **un-render** background | `view.setVisible(false)` | 2.5% | 826 MB | 8 | ✅ unaffected (<1 ms) |
| C. **throttle** background | `setBackgroundThrottling(true)` at runtime | 1.1% | ~840 MB | 8 | ⚠️ drift, then stall |
| D. **hibernate** background | `removeChildView` + `webContents.close()` | 0.5% | **164 MB** | **4** | ❌ offline (by design) |

Per-view renderer RAM ≈ **165–175 MB** (synthetic page; real Discord will be higher).

### What each lever actually does
- **Un-render (B)** stops *painting* but JS keeps running, so it does **not** reduce JS-CPU or RAM here — and that's the point: the gateway stays live, notifications keep flowing. Its real benefit is GPU/compositing cost (not measurable headless — flagged for desktop re-test). Treat it as the **always-on default for non-active views**: zero stability cost.
- **Throttle (C)** is the only lever that cuts background JS-CPU, but it is *exactly* the mechanism that kills the heartbeat (see §1). **Never apply to a connected account.** Only acceptable as part of hibernation.
- **Hibernate (D)** is the real RAM/process lever: closing 4 views reclaimed **~697 MB** and **4 OS processes**. The account goes offline and will not notify — so this is **opt-in / auto-after-inactivity only, with the explicit warning** already specified in the plan.

### GC sub-test
Manual `global.gc()` (via `--js-flags=--expose-gc`) on idle background views reclaimed nothing measurable — expected, since the heap was intentionally retained (no garbage to collect). Not a useful runtime lever; rely on hibernation for reclaim.

---

## 3. Recommended resource & stability policy (derived from data)

1. **Every connected account view:** `backgroundThrottling: false`. Non-negotiable.
2. **Active view:** rendered. **All other connected views:** `setVisible(false)` (un-rendered) — keeps them connected at no stability cost while saving compositing/GPU work. Default behavior, no user action.
3. **Hibernation** (destroy WebContents) is the only RAM-reclaim tool. Surface it as: manual per-account toggle + optional auto-hibernate after long inactivity, both with the "hibernated accounts don't notify" warning. Budget ~170 MB+ of renderer RAM back per hibernated account.
4. **Never** call `setBackgroundThrottling(true)` on a view the user expects notifications from. The only time a view should be throttled is the moment before it is hibernated.

**Rule of thumb for sizing:** plan for ≥ ~170 MB renderer RAM per *connected* account (likely 250–400 MB with the real Discord client), reclaimable only by hibernating.

---

## 4. Open items to validate on real hardware / with real Discord
- GPU/compositing savings of un-rendering (needs a real GPU desktop; software-render hides it).
- Real per-account RAM with the actual Discord web client (expect higher than the 170 MB synthetic figure).
- **WebSocket throttling exemption:** Chromium partially exempts pages with active WebSocket/WebRTC from intensive throttling. A real gateway socket *may* soften the throttled-case stall — but the spike shows `backgroundThrottling:false` makes this moot, so we do not depend on it.
- Reconnection behavior across real sleep/wake and network changes (the spike covered hidden-hold, not OS suspend).

---

## How to reproduce
```bash
npm install
npm run build
xvfb-run -a ./node_modules/.bin/electron .            # short A/B/C/D phases, throttling off
BG_THROTTLE=1 xvfb-run -a ./node_modules/.bin/electron .   # same, throttling on
HOLD_MS=420000 BG_THROTTLE=1 xvfb-run -a ./node_modules/.bin/electron .  # 7-min stability hold
```
Reports are written to `report-*.json`.
