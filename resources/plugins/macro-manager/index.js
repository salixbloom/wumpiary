// Macro Manager — headless half. Owns the global hotkeys and dispatches macros.
//
// ⚠ Account automation is strictly prohibited by Discord and can result in
// permanent account suspension. This plugin is unsupported; use it responsibly
// and at your own risk.
//
// Flow: register each macro's hotkey -> on press, broadcast the macro to the
// content scripts -> the (single) VISIBLE Discord view runs it against the
// `macro` API. Clipboard is fire-only here: a macro can ask us to trigger the OS
// copy/paste on the focused field, but the plugin can never read or set its
// contents.

module.exports = (api) => {
  let registered = [];
  const macros = () => api.storage.get('macros', []);

  async function unregisterAll() {
    for (const h of registered) { try { api.hotkeys.unregister(h); } catch (e) { /* ignore */ } }
    registered = [];
  }

  async function setup() {
    await unregisterAll();
    for (const m of macros()) {
      if (!m.hotkey) continue;
      try {
        const ok = await api.hotkeys.register(m.hotkey);
        if (ok) registered.push(m.hotkey);
        else api.log('hotkey already in use:', m.hotkey);
      } catch (e) { api.log('hotkey register failed', m.hotkey, String(e)); }
    }
  }

  const offHotkey = api.on('hotkey', async ({ accelerator }) => {
    const m = macros().find((x) => x.hotkey === accelerator);
    if (!m) return;
    api.broadcast('macro:run', { name: m.name, code: m.code });
  });

  // A macro can ask us to fire the OS copy/paste on the focused Discord field
  // (macro.copy() / macro.paste()). Clipboard is fire-only — we cannot read or
  // set its contents — so these expose no data to the plugin.
  const offCopy = api.on('message:macro:copy', () => { try { api.clipboard.copy(); } catch (e) { /* ignore */ } });
  const offPaste = api.on('message:macro:paste', () => { try { api.clipboard.paste(); } catch (e) { /* ignore */ } });

  // The editor saved changes — re-bind hotkeys.
  const offReload = api.on('message:macro:reload', () => setup());

  setup();

  return () => { offHotkey(); offCopy(); offPaste(); offReload(); unregisterAll(); };
};
