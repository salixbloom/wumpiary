// Content Warning — headless half.
//
// The word list is the source of truth here, in plugin storage. The Filters
// panel edits it; the content script (which runs inside each Discord view)
// requests it on load and re-applies it whenever it changes. All three contexts
// talk over the per-plugin broadcast bus (api.broadcast / api.on('message:…')).

module.exports = (api) => {
  const words = () => api.storage.get('words', []);

  // A freshly-loaded content script asks for the current list.
  const offGet = api.on('message:cw:get', () => api.broadcast('cw:words', words()));

  // The panel pushes an edited list: persist it, then tell everyone.
  const offSet = api.on('message:cw:set', (list) => {
    const clean = Array.isArray(list) ? list.map(String).filter(Boolean) : [];
    api.storage.set('words', clean);
    api.broadcast('cw:words', clean);
  });

  // Announce once at startup for any content script already running.
  api.broadcast('cw:words', words());

  return () => { offGet(); offSet(); };
};
