// Asset Grabber — headless half. Holds the `network` + `files` capabilities.
// The content script (which can see the page but has neither) hands us a URL;
// we fetch the bytes and open a native Save dialog.

module.exports = (api) => {
  const off = api.on('message:asset:save', async (req) => {
    const url = req && req.url;
    if (!url) return;
    try {
      const res = await api.http({ url });
      if (!res || res.error || !res.ok || !res.body) {
        // The shell stamps the origin (plugin name) as the title itself, so we
        // only pass a body.
        api.notify && api.notify({ body: 'Could not download that asset.' });
        api.log('fetch failed', url, res && res.error);
        return;
      }
      const saved = await api.files.save({
        suggestedName: req.name || 'asset.png',
        data: res.body,
        filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }, { name: 'All files', extensions: ['*'] }],
      });
      if (saved && saved.ok) api.log('saved', saved.path);
    } catch (e) {
      api.log('error', String(e));
    }
  });

  return () => off();
};
