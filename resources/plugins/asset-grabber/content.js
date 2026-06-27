// Asset Grabber — content script. Floats a "Save" button over any Discord CDN
// image you hover, and broadcasts the original-resolution URL to the headless
// half (which has the `network` + `files` permissions) to fetch and save.

var CDN = /(cdn|media)\.discord(app)?\.(com|net)/;

wumpiary.addStyle(
  '.wump-grab{position:fixed;z-index:99999;display:none;align-items:center;gap:4px;' +
  'font:600 11px/1 system-ui,sans-serif;color:#fff;background:#5865f2;border:0;border-radius:6px;' +
  'padding:5px 8px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}'
);

var btn = document.createElement('button');
btn.className = 'wump-grab';
btn.textContent = '⤓ Save';
document.body.appendChild(btn);
var current = null;
var hideTimer = null;

function upgrade(url) {
  try {
    var u = new URL(url, location.href);
    if (u.searchParams.has('size')) u.searchParams.set('size', '4096');
    return u.toString();
  } catch (e) { return url; }
}

function nameFor(url) {
  try {
    var u = new URL(url, location.href);
    var base = (u.pathname.split('/').pop() || 'asset').split('?')[0];
    return base.replace(/\.(webp|jpg|jpeg|avif)$/i, '.png') || 'asset.png';
  } catch (e) { return 'asset.png'; }
}

function place(img) {
  current = img;
  var r = img.getBoundingClientRect();
  if (r.width < 16 || r.height < 16) { hideBtn(); return; }
  btn.style.left = Math.max(2, r.right - 60) + 'px';
  btn.style.top = Math.max(2, r.top + 4) + 'px';
  btn.style.display = 'flex';
}

function hideBtn() { btn.style.display = 'none'; current = null; }

function onOver(e) {
  var t = e.target;
  var img = t && t.closest ? t.closest('img') : null;
  if (!img || !img.src || !CDN.test(img.src)) return;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  place(img);
}

function onOut(e) {
  if (e.target === btn) return;
  hideTimer = setTimeout(hideBtn, 250);
}

document.addEventListener('mouseover', onOver, true);
document.addEventListener('mouseout', onOut, true);
btn.addEventListener('mouseenter', function () { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
btn.addEventListener('mouseleave', function () { hideTimer = setTimeout(hideBtn, 250); });
btn.addEventListener('click', function (e) {
  e.preventDefault();
  e.stopPropagation();
  if (!current) return;
  var url = upgrade(current.src);
  wumpiary.broadcast('asset:save', { url: url, name: nameFor(url) });
  btn.textContent = '⤓ Saving…';
  setTimeout(function () { btn.textContent = '⤓ Save'; }, 1400);
});

return function () {
  document.removeEventListener('mouseover', onOver, true);
  document.removeEventListener('mouseout', onOut, true);
  btn.remove();
};
