// P2P Music — content script (runs INSIDE the Discord view; needs the
// `discord-view` permission). It uses ordinary Discord messages as the WebRTC
// signalling channel for a listen-together session:
//
//   • spots an invite code someone posted  -> hides the raw code and renders a
//     Discord-style invite card with a "Join" button
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

// Card design mirrors Discord's own server-invite embed: a banner, an overlapped
// rounded icon, a title + status sub-line, and a full-width footer button. Built
// only from class selectors + theme vars so it tracks light/dark automatically.
wumpiary.addStyle(
  '.wump-p2p-card{width:340px;max-width:100%;margin:6px 0;border-radius:8px;overflow:hidden;' +
  'background:var(--background-secondary-alt,var(--bg-mod-faint,#2b2d31));' +
  'border:1px solid var(--border-subtle,rgba(255,255,255,.08));' +
  'font-family:var(--font-primary,sans-serif);box-shadow:0 1px 3px rgba(0,0,0,.2)}' +
  '.wump-p2p-card-banner{height:56px;background:radial-gradient(105% 127% at 50% 127%,#7b87ff 18%,#3a2f6b 85%)}' +
  '.wump-p2p-card-body{padding:0 16px 16px}' +
  '.wump-p2p-card-icon{width:48px;height:48px;margin-top:-24px;border-radius:16px;' +
  'display:flex;align-items:center;justify-content:center;font-size:24px;' +
  'background:#5865f2;color:#fff;border:5px solid var(--background-secondary-alt,#2b2d31);' +
  'box-shadow:0 0 0 1px rgba(0,0,0,.1)}' +
  '.wump-p2p-card-title{margin-top:8px;font:700 16px/1.25 var(--font-primary,sans-serif);color:var(--text-strong,#f2f3f5)}' +
  '.wump-p2p-card-sub{display:flex;align-items:center;gap:6px;margin-top:4px;' +
  'font:500 13px/1.3 var(--font-primary,sans-serif);color:var(--text-subtle,#b5bac1)}' +
  '.wump-p2p-dot{width:8px;height:8px;border-radius:50%;background:#23a55a;flex:none}' +
  '.wump-p2p-card[data-state="mine"] .wump-p2p-dot{background:#f0b232}' +
  '.wump-p2p-card[data-state="joining"] .wump-p2p-dot{background:#949ba4}' +
  '.wump-p2p-card-foot{margin-top:14px}' +
  '.wump-p2p-card-btn{width:100%;border:0;border-radius:8px;padding:8px 16px;cursor:pointer;' +
  'background:#5865f2;color:#fff;font:600 14px/1.2 var(--font-primary,sans-serif)}' +
  '.wump-p2p-card-btn:hover{background:#4752c4}' +
  '.wump-p2p-card-btn[disabled]{opacity:.6;cursor:default}' +
  '.wump-p2p-note{margin:4px 0;font:600 11px/1.3 var(--font-primary,sans-serif);color:#949ba4}'
);

function messages() {
  return wumpiary.queryAll('li[class*="messageListItem"]');
}

// Build a node via DOM APIs only — Discord enforces Trusted Types, so assigning
// innerHTML from a string would throw.
function elem(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Where to graft our embed: the message's accessories slot (where real invite
// cards live), falling back to the list item itself.
function host(el) {
  return el.querySelector('[id^="message-accessories-"]') || el;
}
function codeEl(el) {
  return el.querySelector('[id^="message-content-"]');
}

function clearTag(el) {
  var nodes = el.querySelectorAll('.wump-p2p-card, .wump-p2p-note');
  for (var i = 0; i < nodes.length; i++) nodes[i].remove();
  var c = codeEl(el);
  if (c) c.style.display = ''; // un-hide the raw code (node may be recycled)
}

// Render the invite card. `state` is 'join' | 'mine' | 'joining'. Idempotent:
// keeps the raw code hidden every pass and only rebuilds when the state changes.
function ensureCard(el, state, inviteId, code) {
  var c = codeEl(el);
  if (c) c.style.display = 'none';
  var h = host(el);
  var existing = h.querySelector('.wump-p2p-card');
  if (existing && existing.getAttribute('data-state') === state) return;
  clearTag(el);
  if (c) c.style.display = 'none';

  var card = elem('div', 'wump-p2p-card');
  card.setAttribute('data-state', state);
  var body = elem('div', 'wump-p2p-card-body');
  body.appendChild(elem('div', 'wump-p2p-card-icon', '🎧'));
  body.appendChild(elem('div', 'wump-p2p-card-title', 'Listening Session'));
  var sub = elem('div', 'wump-p2p-card-sub');
  sub.appendChild(elem('span', 'wump-p2p-dot'));
  var foot = elem('div', 'wump-p2p-card-foot');

  if (state === 'join') {
    sub.appendChild(elem('span', null, 'Live now • Listen together'));
    var btn = elem('button', 'wump-p2p-card-btn', '🎧 Join listening session');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true; btn.textContent = 'Joining…';
      joined[inviteId] = true;
      wumpiary.broadcast('p2p:join', { inviteId: inviteId, code: code });
    });
    foot.appendChild(btn);
  } else if (state === 'mine') {
    sub.appendChild(elem('span', null, 'Your session • open this chat with a friend to let them join'));
  } else { // joining
    sub.appendChild(elem('span', null, 'Connecting…'));
    var b2 = elem('button', 'wump-p2p-card-btn', 'Joining…');
    b2.disabled = true;
    foot.appendChild(b2);
  }

  body.appendChild(sub);
  body.appendChild(foot);
  card.appendChild(elem('div', 'wump-p2p-card-banner'));
  card.appendChild(body);
  h.appendChild(card);
}

// A lightweight note (used for a listener's answer message), also hiding the
// raw reply code.
function ensureNote(el, text) {
  var c = codeEl(el);
  if (c) c.style.display = 'none';
  var h = host(el);
  var n = h.querySelector('.wump-p2p-note');
  if (n) { if (n.textContent !== text) n.textContent = text; return; }
  clearTag(el);
  if (c) c.style.display = 'none';
  h.appendChild(elem('div', 'wump-p2p-note', text));
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
      var rId = rep[1], rCode = rep[2];
      ensureNote(el, mine[rId] ? '♫ A friend joined your session' : '♫ Joined the session');
      if (mine[rId] && !seenReply[rCode]) { seenReply[rCode] = true; wumpiary.broadcast('p2p:response', { inviteId: rId, code: rCode }); }
      continue;
    }
    var inv = INVITE_RE.exec(text);
    if (!inv) { clearTag(el); continue; } // node reused for a non-code message
    var id = inv[1], code = inv[2];
    if (mine[id]) ensureCard(el, 'mine', id, code);
    else if (joined[id]) ensureCard(el, 'joining', id, code);
    else ensureCard(el, 'join', id, code);
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
