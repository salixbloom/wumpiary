// P2P Music — content script (runs INSIDE the Discord view; needs the
// `discord-view` permission). It uses ordinary Discord messages as the WebRTC
// signalling channel for a listen-together session:
//
//   • spots an invite code someone posted  -> shows a "Join" button
//   • on your click, posts your machine's answer back into the same chat
//   • on the host's machine, auto-reads that answer and hands it to the window
//
// All WebRTC lives in the plugin window; this half only reads/writes Discord
// messages, and only ever *sends* one on your explicit action (clicking Join, or
// the window posting an invite you asked it to). Codes look like
//   plugin://p2p-<inviteId>~<sdp>            (host's invite)
//   plugin://p2p-response-<inviteId>~<sdp>   (a listener's answer)

var INVITE_RE = /plugin:\/\/p2p-([a-z0-9]{4,12})~([A-Za-z0-9\-_]+)/;
var REPLY_RE = /plugin:\/\/p2p-response-([a-z0-9]{4,12})~([A-Za-z0-9\-_]+)/;

var mine = {};        // inviteIds this machine is hosting -> never offer ourselves Join
var joined = {};      // inviteIds we've already joined as a listener
var seenReply = {};   // reply codes already forwarded to the host window

wumpiary.addStyle(
  '.wump-p2p-join{display:inline-flex;align-items:center;gap:6px;margin:4px 0;padding:5px 12px;' +
  'border:0;border-radius:6px;background:#5865f2;color:#fff;font:600 12px/1.2 var(--font-primary,sans-serif);' +
  'cursor:pointer}' +
  '.wump-p2p-join[disabled]{opacity:.5;cursor:default}' +
  '.wump-p2p-note{margin:4px 0;font:600 11px/1.3 var(--font-primary,sans-serif);color:#949ba4}'
);

function messages() {
  return wumpiary.queryAll('li[class*="messageListItem"]');
}

function clearTag(el) {
  var t = el.querySelector('.wump-p2p-join, .wump-p2p-note');
  if (t) t.remove();
}
function ensureJoin(el, inviteId, code) {
  if (el.querySelector('.wump-p2p-join')) return;
  clearTag(el);
  var btn = document.createElement('button');
  btn.className = 'wump-p2p-join';
  btn.textContent = '🎧 Join listening session';
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = '🎧 Joining…';
    joined[inviteId] = true;
    wumpiary.broadcast('p2p:join', { inviteId: inviteId, code: code });
  });
  el.appendChild(btn);
}
function ensureNote(el, text) {
  var n = el.querySelector('.wump-p2p-note');
  if (n) { if (n.textContent !== text) n.textContent = text; var j = el.querySelector('.wump-p2p-join'); if (j) j.remove(); return; }
  clearTag(el);
  var d = document.createElement('div');
  d.className = 'wump-p2p-note';
  d.textContent = text;
  el.appendChild(d);
}

// Idempotent: reconciles each visible message's tag to the desired state, so it
// survives Discord recycling list nodes as you scroll.
function scan() {
  if (document.visibilityState !== 'visible') return; // only the chat you're looking at
  var list = messages();
  for (var i = 0; i < list.length; i++) {
    var el = list[i];
    var text = el.innerText || '';
    var rep = REPLY_RE.exec(text);
    if (rep) {
      clearTag(el);
      var rId = rep[1], rCode = rep[2];
      if (mine[rId] && !seenReply[rCode]) { seenReply[rCode] = true; wumpiary.broadcast('p2p:response', { inviteId: rId, code: rCode }); }
      continue;
    }
    var inv = INVITE_RE.exec(text);
    if (!inv) { clearTag(el); continue; } // node reused for a non-code message
    var id = inv[1], code = inv[2];
    if (mine[id]) { ensureNote(el, '♫ Your invite — open this chat with a friend to let them join.'); }
    else if (joined[id]) { ensureNote(el, '♫ Joining…'); }
    else ensureJoin(el, id, code);
  }
}

var pending = null;
function schedule() { if (pending) return; pending = setTimeout(function () { pending = null; scan(); }, 120); }

var offMut = wumpiary.onMutation(schedule);
var offMine = wumpiary.on('message:p2p:mine', function (d) { if (d && d.inviteId) { mine[d.inviteId] = true; schedule(); } });
var offPost = wumpiary.on('message:p2p:post', function (d) {
  if (!d || !d.text) return;
  if (document.visibilityState !== 'visible') return;   // post only into the active account/chat
  if (!wumpiary.input.targetMessageBox()) return;
  wumpiary.input.type(String(d.text));
  setTimeout(function () { wumpiary.input.send(); }, 180);
});

document.addEventListener('visibilitychange', schedule);
scan();

return function () { offMut(); offMine(); offPost(); document.removeEventListener('visibilitychange', schedule); if (pending) clearTimeout(pending); };
