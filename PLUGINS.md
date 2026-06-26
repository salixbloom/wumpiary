# Writing wumpiary plugins

Plugins extend **wumpiary's own shell** — they react to notifications and account
activity, post their own notifications, persist small bits of state, and apply
cosmetic CSS to the Discord views. They deliberately **cannot run code inside the
Discord web client** (wumpiary stays observe-only — see [PLAN.md](PLAN.md) §10).

## Security model

- Plugin code runs in a hidden, sandboxed host window with **no Node access and
  no network** (the host's CSP is `connect-src 'none'`). A plugin can only reach
  the curated `api` object wumpiary hands it.
- Every capability that exposes something you'd care about is **permission-gated**.
  A plugin only receives the parts of `api` it was granted, and the main process
  re-checks each grant before acting on it.
- Plugins are **disabled by default**. You enable them and grant each permission
  individually in **Settings → Plugins**. Decisions are stored in
  `plugins/permissions.json` under wumpiary's user-data directory.

> Only install plugins you trust. A sandboxed plugin can't touch the network or
> your files, but an enabled one can still post notifications and restyle Discord.

## Installing a plugin

1. **Settings → Plugins → Open folder** (this is `<userData>/plugins/`).
2. Drop the plugin's folder inside, e.g. `plugins/loud-mentions/`.
3. **Reload**. The plugin appears in the list — toggle it on and grant permissions.

## Anatomy

A plugin is a folder containing a `manifest.json` and an entry script:

```
loud-mentions/
  manifest.json
  index.js
```

### `manifest.json`

```json
{
  "id": "loud-mentions",          // kebab-case; MUST match the folder name
  "name": "Loud Mentions",
  "version": "1.0.0",
  "description": "…",
  "author": "you",
  "entry": "index.js",            // relative to the folder; can't escape it
  "permissions": ["notifications", "discord-css"]
}
```

### Entry script

CommonJS — export an `activate(api)` function. Return a cleanup function that
runs when the plugin is disabled or reloaded.

```js
module.exports = (api) => {
  const off = api.on('notification', (n) => {
    if (n.kind === 'mention') api.notify({ title: 'mention!', body: n.body });
  });
  return () => off();
};
// or: module.exports = { activate(api) { … }, };
```

## Permissions

| Permission     | Unlocks                                                                        |
|----------------|--------------------------------------------------------------------------------|
| `accounts`     | `api.getAccounts()` and the `accounts` event (nicknames, counts, connection).  |
| `notifications`| The `notification` event (message content) **and** `api.notify(...)`.          |
| `discord-css`  | `api.setDiscordCss(css)` — cosmetic CSS injected into every Discord view.       |

If a permission isn't granted, the corresponding `api` method is simply absent —
guard with `if (api.notify) …`.

## API reference

Always available (no permission needed):

- `api.id` — your plugin id.
- `api.on(event, handler)` → returns an unsubscribe function.
- `api.log(...args)` — logs to wumpiary's console, tagged with your id.
- `api.storage.get(key, default)` / `set(key, value)` / `delete(key)` / `all()` —
  small JSON-serializable per-plugin persistence.

Permission-gated:

- `api.getAccounts()` *(accounts)* → array of `{ id, nickname, color, connection,
  unread, mentions, hibernated, signedIn }`.
- `api.notify({ title, body })` *(notifications)*.
- `api.setDiscordCss(css)` *(discord-css)* — pass `''` to clear yours.

### Events

| Event          | Permission     | Payload                                                          |
|----------------|----------------|------------------------------------------------------------------|
| `notification` | `notifications`| `{ accountId, nickname, title, body, kind }` — `kind` is `message \| mention \| dm \| call`. |
| `accounts`     | `accounts`     | the same array as `api.getAccounts()`, fired when it changes.    |

## Example

A complete, commented example lives in
[`examples/plugins/loud-mentions/`](examples/plugins/loud-mentions/). Copy that
folder into your plugins directory to try it.
