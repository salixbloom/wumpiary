// Macro Manager — content script. Executes a macro against the live Discord DOM.
//
// Safety: this runs in EVERY account view, but a macro only executes in the one
// that is currently VISIBLE (the account you're looking at), so a hotkey never
// fires actions across all of your accounts at once.

wumpiary.on('message:macro:run', function (m) {
  if (document.visibilityState !== 'visible') return; // only the active account acts
  var input = wumpiary.input;
  var macro = {
    // selection + chat helpers
    targetMessageBox: function () { return input.targetMessageBox(); },
    focusMessageBox: function () { return input.focusMessageBox(); },
    type: function (text) { return input.type(text); },
    send: function () { return input.send(); },
    click: function (sel) { return input.click(sel); },
    wait: function (ms) { return input.wait(ms); },
    getSelection: function () { return input.getSelectionText(); },
    // dom access (read-only convenience)
    query: function (sel) { return wumpiary.query(sel); },
    queryAll: function (sel) { return wumpiary.queryAll(sel); },
    // clipboard is fire-only: trigger the OS copy/paste on the focused field
    // (e.g. focusMessageBox() then paste()). A macro can never read or set the
    // clipboard's contents.
    copy: function () { wumpiary.broadcast('macro:copy'); return true; },
    paste: function () { wumpiary.broadcast('macro:paste'); return true; },
    log: function () { wumpiary.log.apply(null, arguments); },
  };
  try {
    // Macros are async-capable: wrap so `await macro.wait(...)` works.
    var fn = new Function('macro', '"use strict";return (async () => {' + m.code + '\n})();');
    Promise.resolve(fn(macro)).catch(function (e) { wumpiary.log('macro error:', String(e)); });
  } catch (e) {
    wumpiary.log('macro parse error:', String(e));
  }
});
