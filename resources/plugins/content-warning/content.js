// Content Warning — content script (runs INSIDE the Discord view, needs the
// `discord-view` permission). It scans rendered messages for any filtered word
// and blurs the whole message behind a click-to-reveal overlay.

var words = [];

wumpiary.addStyle(
  '.wump-cw-hidden > *{filter:blur(10px) !important;opacity:.2 !important;pointer-events:none !important;user-select:none !important}' +
  '.wump-cw-host{position:relative !important}' +
  '.wump-cw-tag{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:6px;' +
  'cursor:pointer;z-index:5;font:600 12px/1.3 var(--font-primary,sans-serif);text-align:center;color:#fff;' +
  'background:rgba(0,0,0,.35);border-radius:6px}'
);

function messages() {
  return wumpiary.queryAll('li[class*="messageListItem"], [id^="chat-messages-"]');
}

function hit(el) {
  if (!words.length) return false;
  var t = (el.innerText || '').toLowerCase();
  for (var i = 0; i < words.length; i++) if (t.indexOf(words[i]) !== -1) return true;
  return false;
}

function hide(el) {
  if (el.__cwHidden) return;
  el.__cwHidden = true;
  el.classList.add('wump-cw-host', 'wump-cw-hidden');
  var tag = document.createElement('div');
  tag.className = 'wump-cw-tag';
  tag.textContent = '⚠ Hidden by content warning — click to reveal';
  tag.addEventListener('click', function (e) {
    e.stopPropagation();
    el.classList.remove('wump-cw-hidden');
    tag.remove();
  });
  el.appendChild(tag);
}

function clearAll() {
  var hosts = wumpiary.queryAll('.wump-cw-host');
  for (var i = 0; i < hosts.length; i++) {
    var el = hosts[i];
    el.classList.remove('wump-cw-host', 'wump-cw-hidden');
    el.__cwHidden = false;
    var tag = el.querySelector('.wump-cw-tag');
    if (tag) tag.remove();
  }
}

function scan() {
  if (!words.length) return;
  var list = messages();
  for (var i = 0; i < list.length; i++) if (!list[i].__cwHidden && hit(list[i])) hide(list[i]);
}

var offMut = wumpiary.onMutation(scan);
var offWords = wumpiary.on('message:cw:words', function (list) {
  words = (list || []).map(function (w) { return String(w).toLowerCase(); }).filter(Boolean);
  clearAll();
  scan();
});

// Ask the headless half for the current list.
wumpiary.broadcast('cw:get');

return function () { offMut(); offWords(); clearAll(); };
