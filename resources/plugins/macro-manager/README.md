# Macro Manager

Write scripted macros bound to global hotkeys that drive the **active** Discord
view — focus the message box, type, send, click elements, trigger copy/paste,
and more.

> ⚠ **Account automation is strictly prohibited by Discord and can result in
> permanent account suspension.** This plugin is provided as-is and unsupported.
> Use it responsibly and entirely at your own risk.

## Setup

1. Enable **Macro Manager** in Settings → Plugins.
2. Grant **discord-view** (to act in Discord), **hotkeys** (to trigger macros),
   and **clipboard** (optional, to let macros trigger copy/paste).
3. Click **Open Macro Editor** on the plugin card.

## Writing a macro

1. **＋ New macro**, give it a **name** and a **global hotkey**
   (e.g. `CommandOrControl+Shift+G`).
2. Write a script in the editor, then **Save** — the hotkey becomes active
   immediately.
3. Press the hotkey anywhere; the macro runs in whichever account you're
   currently looking at (it never fires across all accounts at once).

## Macro API

Your script runs with a `macro` object:

- `macro.targetMessageBox()` — focus/select the message box.
- `macro.type(text)` — type into the focused field.
- `macro.send()` — press Enter to send.
- `macro.click(selector)` — click a matching element.
- `await macro.wait(ms)` — pause (scripts are async).
- `macro.getSelection()` — the currently selected text.
- `macro.copy()` — fire the OS copy on the focused field (e.g. after selecting).
- `macro.paste()` — fire the OS paste into the focused field (e.g. the message
  box). Clipboard is fire-only: a macro can never read or set its contents.
- `macro.query(sel)` / `macro.queryAll(sel)` — read the DOM.
- `macro.log(...)` — log to wumpiary's console.

### Example

```js
// Insert a canned response and send it.
macro.targetMessageBox();
macro.type('on my way!');
macro.send();
```

## Notes

- Discord's editor is built on a rich text framework; synthetic input is
  best-effort and a future Discord update may change what works.
- Use sane hotkeys that don't clash with Discord or the OS.
