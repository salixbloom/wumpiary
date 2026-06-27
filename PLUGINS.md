# Writing wumpiary plugins

Plugins extend **wumpiary's own shell**. They react to notifications and account
activity, post notifications, persist state, apply cosmetic CSS to the Discord
views, render their own UI (an interior panel and/or a standalone window), reach
the network and the filesystem, register global hotkeys — and, with the one
high-trust permission, run a content script **inside** the Discord web client.

Four plugins ship with wumpiary as working examples (see [Bundled plugins](#bundled-plugins)).

## Security model

- Plugin code always runs **sandboxed with no Node access**. The headless half
  runs in a CSP-locked host window with **no network** (`connect-src 'none'`);
  UI surfaces load the plugin's own files from a per-plugin origin
  (`wumpiary-plugin://<id>/`) and only reach the network if the plugin was
  granted `network`.
- Every capability that exposes something you'd care about is
  **permission-gated**. A plugin only receives the parts of the API it was
  granted, and **the main process re-checks each grant** before acting — and for
  UI surfaces it derives the calling plugin from the window itself, never from
  what the message claims.
- Plugins are **disabled by default**. You enable them and grant each permission
  individually in **Settings → Plugins**. Decisions live in
  `plugins/permissions.json` under wumpiary's user-data directory.

> Only install plugins you trust. Pay special attention to **`discord-view`** —
> it lets a plugin read and act inside Discord — and to any plugin showing the
> **⚠ automation** badge.

## Installing a plugin

1. **Settings → Plugins → Open folder** (this is `<userData>/plugins/`).
2. Drop the plugin's folder inside, e.g. `plugins/my-plugin/`.
3. **Reload**. The plugin appears in the list — toggle it on and grant permissions.

## Anatomy

A plugin is a folder with a `manifest.json` and one or more of: a headless entry
script, a content script, and UI files.

```
my-plugin/
  manifest.json
  index.js        # headless entry (optional)
  content.js      # injected into Discord views (optional; needs discord-view)
  window.html     # standalone window UI (optional)
  panel.html      # config panel, shown in Settings via the ⚙ button (optional)
  README.md       # rendered by the ? button as the plugin's help page (optional)
```

### `manifest.json`

```jsonc
{
  "id": "my-plugin",              // kebab-case; MUST match the folder name
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "…",
  "author": "you",
  "entry": "index.js",           // headless script (optional)
  "contentScript": "content.js", // Discord-view script (optional; needs discord-view)
  "permissions": ["notifications", "network"],
  "metadata": {                  // display-only badges in the plugin list
    "automationWarning": true,   // ⚠ Discord-automation warning badge
    "experimental": true,        // “experimental” badge
    "tags": ["music", "p2p"],
    "homepage": "https://…"
  },
  "ui": {
    "panel":  { "entry": "panel.html",  "title": "Queue" },
    "window": { "entry": "window.html", "title": "Player", "width": 460, "height": 720, "frame": false }
  }
}
```

### Headless entry script

CommonJS — export an `activate(api)` function (or `module.exports = (api) => …`).
Return a cleanup function that runs on disable/reload.

```js
module.exports = (api) => {
  const off = api.on('notification', (n) => {
    if (n.kind === 'mention') api.notify({ title: 'mention!', body: n.body });
  });
  return () => off();
};
```

### UI surfaces (window / panel) and help

Plain HTML loaded from your plugin folder. A frozen `window.wumpiary` global is
available to your page scripts (same API as the headless `api`, but storage and
the gated request/response calls are async — they return Promises). Inline
`<script>` is allowed.

- **`ui.window`** — a standalone (optionally frameless) window the user opens
  with **Open window** on the plugin card, or your code opens with
  `api.window.open()`.
- **`ui.panel`** — a config page shown **inside Settings → Plugins** when the
  user clicks the **⚙** button on your card; it's torn down when they go back, so
  it never floats over the rest of the app. Use it for plugin settings.
- **`README.md`** — if present, a **?** button on the card renders it as the
  plugin's help page. Great place for usage instructions.

```html
<script>
  const w = window.wumpiary;
  document.querySelector('#go').onclick = async () => {
    const res = await w.http({ url: 'https://example.com/data.json' });
    w.log('status', res.status);
  };
  w.window.close(); // close my own window
</script>
```

### Content scripts (`discord-view`)

Injected into **every** Discord account view. This is the explicit,
off-by-default exception to wumpiary's observe-only rule — it is the one place a
plugin can read and write Discord's page. The `wumpiary` content API is DOM- and
input-focused (see below). It runs in every view, so input actions that should
affect only the account you're looking at should guard on
`document.visibilityState === 'visible'`.

## Permissions

| Permission      | Unlocks |
|-----------------|---------|
| `accounts`      | `api.getAccounts()` and the `accounts` event (nicknames, counts, connection). |
| `notifications` | The `notification` event (message content) **and** `api.notify(...)`. |
| `discord-css`   | `api.setDiscordCss(css)` — cosmetic CSS injected into every Discord view. |
| `discord-view`  | **High trust.** Inject your `contentScript` into Discord views; read/hide/extract page content and simulate input (type/send/click). |
| `network`       | `api.http(req)` (proxied through main) **and** lets your window/panel connect out (fetch / WebSocket / WebRTC). |
| `files`         | `api.files.save({...})` / `api.files.open({...})` via native dialogs. |
| `clipboard`     | `api.clipboard.writeText/readText`. |
| `hotkeys`       | `api.hotkeys.register(accelerator)` → fires the `hotkey` event. |

If a permission isn't granted, the corresponding method is simply absent — guard
with `if (api.http) …`.

## API reference

### Always available (headless `api` and UI `window.wumpiary`)

- `api.id` — your plugin id.
- `api.on(event, handler)` → returns an unsubscribe function.
- `api.log(...args)` — logs to wumpiary's console, tagged with your id.
- `api.storage.get(key, default)` / `set(key, value)` / `delete(key)` / `all()` —
  small JSON per-plugin persistence, **shared across all of your plugin's
  contexts**. (In UI surfaces `get`/`all` return Promises.)
- `api.broadcast(channel, data)` — message your plugin's other contexts
  (headless ↔ window ↔ panel ↔ content scripts); receive with
  `api.on('message:' + channel, cb)`.
- `api.window.open()` / `api.window.close()` — open/close your declared window.
  (The config panel is opened by the user from Settings, not by the plugin.)

### Permission-gated

- `api.getAccounts()` *(accounts)* → array of account snapshots; the `accounts` event fires on change.
- `api.notify({ title, body })` *(notifications)*; the `notification` event delivers `{ accountId, nickname, title, body, kind }` where `kind` is `message | mention | dm | call`.
- `api.setDiscordCss(css)` *(discord-css)* — pass `''` to clear yours.
- `api.http({ url, method?, headers?, body? })` *(network)* → `{ ok, status, headers, contentType, body }` where `body` is a `Uint8Array`.
- `api.files.save({ suggestedName?, data, filters? })` *(files)* — `data` is a `Uint8Array`; opens a Save dialog → `{ ok, path }`.
- `api.files.open({ multiple?, filters? })` *(files)* — Open dialog → `{ ok, files: [{ name, size, data }] }` (`data` is a `Uint8Array`).
- `api.clipboard.writeText(s)` / `api.clipboard.readText()` *(clipboard)*.
- `api.hotkeys.register(accelerator)` *(hotkeys)* → boolean; presses fire the `hotkey` event with `{ accelerator }`. `api.hotkeys.unregister(accelerator)`.

### Content-script `wumpiary` (only inside `contentScript`)

- `wumpiary.accountId` — which account view this is.
- `wumpiary.query(sel)` / `queryAll(sel)` / `onMutation(cb)` / `addStyle(css)`.
- `wumpiary.hide(el)` / `reveal(el)` — toggle wumpiary's hide class on an element.
- `wumpiary.broadcast(channel, data)` / `wumpiary.on('message:' + channel, cb)`.
- `wumpiary.input.targetMessageBox()` / `type(text)` / `send()` / `click(sel)` / `getSelectionText()` / `wait(ms)`.

## Bundled plugins

These ship with wumpiary (in `resources/plugins/`) and are seeded into your
plugins folder on first run; they are great references. All are disabled by
default.

- **Content Warning** (`discord-view`) — blurs messages containing your filtered
  words until you click to reveal; manage the list from its panel.
- **Asset Grabber** (`discord-view`, `network`, `files`) — hover any Discord
  image and click Save to download the original-resolution file.
- **P2P Music** (`network`, `files`) — a serverless listen-together player; load
  local tracks and stream them (Opus over WebRTC) to a friend via a copy-paste
  invite code.
- **Macro Manager** (`discord-view`, `hotkeys`, `clipboard`) — write scripted
  macros bound to global hotkeys that drive the active Discord view. Carries the
  **⚠ automation** warning: account automation is against Discord's ToS and can
  get your account suspended — use responsibly and at your own risk.
