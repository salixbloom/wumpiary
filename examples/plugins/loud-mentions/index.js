// Loud Mentions — an example wumpiary plugin.
//
// A plugin is a CommonJS module exporting an `activate(api)` function (either
// `module.exports = (api) => {}` or `module.exports = { activate(api) {} }`).
// Return a function to run cleanup when the plugin is disabled/reloaded.
//
// The `api` object only contains the capabilities your manifest's `permissions`
// were GRANTED. Here we requested `notifications` and `discord-css`.

module.exports = (api) => {
  let mentionCount = api.storage.get('mentionCount', 0);

  const off = api.on('notification', (n) => {
    // `kind` is one of: message | mention | dm | call
    if (n.kind !== 'mention') return;

    mentionCount += 1;
    api.storage.set('mentionCount', mentionCount);
    api.log(`mention #${mentionCount} on "${n.nickname}": ${n.title}`);

    // Post our own, extra notification (needs the `notifications` permission).
    if (api.notify) {
      api.notify({ title: `🔔 @mention — ${n.nickname}`, body: n.body || n.title });
    }

    // Briefly tint the Discord views red, then clear it (needs `discord-css`).
    if (api.setDiscordCss) {
      api.setDiscordCss('html::after{content:"";position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 3px #ED4245;z-index:99999}');
      setTimeout(() => api.setDiscordCss(''), 1500);
    }
  });

  return () => {
    off();
    if (api.setDiscordCss) api.setDiscordCss('');
    api.log('disabled');
  };
};
