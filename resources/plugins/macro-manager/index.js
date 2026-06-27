// Macro Manager — headless half. Owns the global hotkeys and dispatches macros.
//
// ⚠ Account automation is strictly prohibited by Discord and can result in
// permanent account suspension. This plugin is unsupported; use it responsibly
// and at your own risk.
//
// Flow: register each macro's hotkey -> on press, grab the clipboard and
// broadcast the macro to the content scripts -> the (single) VISIBLE Discord
// view runs it against the `macro` API.

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
    let clip = '';
    try { clip = await api.clipboard.readText(); } catch (e) { /* ignore */ }
    api.broadcast('macro:run', { name: m.name, code: m.code, clipboard: clip });
  });

  // The content script can ask us to write the clipboard (macro.setClipboard).
  const offClip = api.on('message:macro:clip', (text) => {
    try { api.clipboard.writeText(String(text)); } catch (e) { /* ignore */ }
  });

  // The editor saved changes — re-bind hotkeys.
  const offReload = api.on('message:macro:reload', () => setup());

  setup();

  return () => { offHotkey(); offClip(); offReload(); unregisterAll(); };
};
