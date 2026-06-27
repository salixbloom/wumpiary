import { ipcRenderer, webFrame } from 'electron';

// Channels inlined (kept in sync with shared/ipc.ts) so this sandboxed preload
// bundles to a single self-contained file with no sibling-chunk requires.
const IPC = {
  obMetrics: 'observer:metrics',
  obTheme: 'observer:theme',
  obNotification: 'observer:notification',
  obConnection: 'observer:connection',
  obFill: 'observer:fill',
  obPushToTalk: 'observer:pushToTalk',
  obSoundConfig: 'observer:soundConfig',
  obCall: 'observer:call',
  obPluginMsg: 'observer:pluginMsg',
} as const;

// OBSERVE-ONLY bridge injected into each Discord account view. It never changes
// Discord's behaviour beyond capturing the Notification it would have shown
// (so we can re-emit it tagged + filtered). It reads unread/mention counts from
// the title and reports connection state. Nothing is automated or sent on the
// user's behalf. See PLAN.md §4 / §10.

const accountId = process.argv.find((a) => a.startsWith('--acct='))?.slice('--acct='.length) ?? '?';
const initialPushToTalkEnabled = process.argv.includes('--ptt-enabled=1');

// Injected into the page's MAIN world (bypasses CSP via webFrame; required to
// wrap window.Notification and read document.title). It only posts messages out
// via window.postMessage — the isolated preload below relays them to main.
const INJECT = `(() => {
  if (window.__wumpInstalled) return; window.__wumpInstalled = true;
  const post = (m) => { try { window.postMessage(m, '*'); } catch (e) {} };

  // Hide Electron from Client Hints (navigator.userAgentData) so Discord treats
  // this as a plain Chrome browser and serves its web streaming path (watch /
  // screen share over WebRTC, no native module). Runs before Discord's scripts.
  try {
    const uad = navigator.userAgentData;
    if (uad) {
      const clean = (list) => (list || []).filter((b) => !/electron|wumpiary|discord/i.test((b && b.brand) || ''));
      const brands = clean(uad.brands);
      const origHEV = uad.getHighEntropyValues ? uad.getHighEntropyValues.bind(uad) : null;
      const fake = {
        brands: brands,
        mobile: false,
        platform: uad.platform,
        toJSON: () => ({ brands: brands, mobile: false, platform: uad.platform }),
        getHighEntropyValues: (hints) => {
          if (!origHEV) return Promise.resolve({ brands: brands, mobile: false, platform: uad.platform });
          return origHEV(hints).then((r) => {
            if (r && r.brands) r.brands = clean(r.brands);
            if (r && r.fullVersionList) r.fullVersionList = clean(r.fullVersionList);
            if (r && r.uaFullVersion) r.uaFullVersion = (r.uaFullVersion + '').replace(/electron.*/i, '');
            return r;
          });
        },
      };
      Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => fake });
    }
  } catch (e) {}

  // When the user picks a custom chime, wumpiary plays it and we mute Discord's
  // OWN notification ding so it isn't heard twice. We can't match Discord's
  // hashed sound-file names, so instead we briefly block short <audio> URL
  // playback right after a notification fires. Voice (srcObject MediaStreams)
  // and unrelated UI sounds are left untouched.
  const soundCfg = { muteNotifSound: false };
  let suppressSoundUntil = 0;
  window.__wumpSetSoundConfig = (cfg) => { soundCfg.muteNotifSound = !!(cfg && cfg.muteNotifSound); };
  try {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try {
        // Audio elements only — never touch <video> (stream/call video).
        if (Date.now() < suppressSoundUntil && (this instanceof HTMLAudioElement) && !this.srcObject && this.src) return Promise.resolve();
      } catch (e) {}
      return origPlay.apply(this, arguments);
    };
  } catch (e) {}

  // Capture (do not display) Discord's web notifications.
  try {
    const Orig = window.Notification;
    function classify(title, body) {
      const hay = ((title || '') + ' ' + (body || '')).toLowerCase();
      if (/ring|incoming call|calling/.test(hay)) return 'call';
      return (title && title.indexOf('#') !== -1) ? 'mention' : 'dm';
    }
    function Wump(title, options) {
      const body = (options && options.body) || '';
      // Open a short window to swallow Discord's own ding for this notification.
      if (soundCfg.muteNotifSound) suppressSoundUntil = Date.now() + 1500;
      post({ __wump: 'notif', title: title || 'Discord', body: body, kind: classify(title, body) });
      return { close(){}, addEventListener(){}, removeEventListener(){}, onclick: null };
    }
    Wump.permission = 'granted';
    Wump.requestPermission = (cb) => { if (cb) cb('granted'); return Promise.resolve('granted'); };
    Wump.maxActions = (Orig && Orig.maxActions) || 0;
    window.Notification = Wump;
  } catch (e) {}

  // App-level push-to-talk: Discord still uses voice activity, but any
  // microphone stream it receives is routed through a gain node that the shell
  // can close unless the configured key is held.
  try {
    const media = navigator.mediaDevices;
    const originalGetUserMedia = media && media.getUserMedia && media.getUserMedia.bind(media);
    const ptt = { enabled: ${initialPushToTalkEnabled}, pressed: false, gains: new Set() };
    const targetGain = () => (ptt.enabled && !ptt.pressed ? 0 : 1);
    const updateGains = () => {
      for (const gain of Array.from(ptt.gains)) {
        try {
          const t = gain.context.currentTime;
          gain.gain.cancelScheduledValues(t);
          gain.gain.setTargetAtTime(targetGain(), t, 0.008);
        } catch (e) {
          ptt.gains.delete(gain);
        }
      }
    };
    // Read your own user id from the bottom-left panel avatar's image URL so we
    // can ring every place that same avatar appears (voice panel, call tile, …).
    const myUserId = () => {
      try {
        const img = document.querySelector('[class*="panels_"] img[src*="/avatars/"], [class*="avatarWrapper"] img[src*="/avatars/"]');
        const src = img && img.getAttribute('src');
        const m = src && src.match(/\\/avatars\\/(\\d+)\\//);
        return m ? m[1] : null;
      } catch (e) { return null; }
    };
    const setPttRing = (on) => {
      try {
        if (on) {
          const uid = myUserId();
          if (uid) {
            // Restrict to voice/call/panel contexts so we don't light up your
            // avatar next to every chat message you've sent.
            const scopes = document.querySelectorAll('[class*="panels_"], section[class*="panel"], [class*="voiceUser"], [class*="tile_"], [class*="participant"], [class*="callContainer"], [class*="participantsWrapper"]');
            scopes.forEach((scope) => {
              scope.querySelectorAll('img[src*="/avatars/' + uid + '/"]').forEach((img) => {
                const wrap = img.closest('[class*="avatar"]') || img.parentElement || img;
                if (wrap) wrap.classList.add('wump-me-ptt');
              });
            });
          }
        } else {
          document.querySelectorAll('.wump-me-ptt').forEach((el) => el.classList.remove('wump-me-ptt'));
        }
      } catch (e) {}
    };
    window.__wumpSetPushToTalk = (state) => {
      ptt.enabled = !!(state && state.enabled);
      ptt.pressed = !!(state && state.pressed);
      updateGains();
      // Green-ring your own avatar(s) while the key is held (see PTT_HELD_CSS).
      const held = ptt.enabled && ptt.pressed;
      try { document.documentElement.classList.toggle('wump-ptt-held', held); } catch (e) {}
      setPttRing(held);
    };
    const wantsAudio = (constraints) => {
      if (!constraints) return false;
      return constraints.audio !== undefined && constraints.audio !== false;
    };
    const wrapStream = (stream) => {
      if (!stream || !stream.getAudioTracks || stream.getAudioTracks().length === 0) return stream;
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) return stream;
      const ctx = new AudioContextCtor();
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      const destination = ctx.createMediaStreamDestination();
      gain.gain.value = targetGain();
      ptt.gains.add(gain);
      source.connect(gain);
      gain.connect(destination);
      const out = new MediaStream([
        ...destination.stream.getAudioTracks(),
        ...stream.getVideoTracks(),
      ]);
      const cleanup = () => {
        ptt.gains.delete(gain);
        try { source.disconnect(); } catch (e) {}
        try { gain.disconnect(); } catch (e) {}
        try { ctx.close(); } catch (e) {}
      };
      for (const track of stream.getTracks()) track.addEventListener('ended', cleanup, { once: true });
      return out;
    };
    if (originalGetUserMedia) {
      media.getUserMedia = async (constraints) => {
        const stream = await originalGetUserMedia(constraints);
        return wantsAudio(constraints) ? wrapStream(stream) : stream;
      };
    }
  } catch (e) {}

  // Active-call detection: track connected RTCPeerConnections and report so the
  // shell can highlight accounts that are currently in a voice/video call.
  try {
    const OrigPC = window.RTCPeerConnection;
    if (OrigPC && !OrigPC.__wumpCallWrapped) {
      const active = new Set();
      let last = null;
      const report = () => {
        const on = active.size > 0;
        if (on !== last) { last = on; post({ __wump: 'call', active: on }); }
      };
      const Wrapped = function (cfg) {
        const pc = new OrigPC(cfg);
        const update = () => {
          if (pc.connectionState === 'connected') active.add(pc); else active.delete(pc);
          report();
        };
        pc.addEventListener('connectionstatechange', update);
        return pc;
      };
      Wrapped.prototype = OrigPC.prototype;
      Object.getOwnPropertyNames(OrigPC).forEach((k) => { try { if (typeof OrigPC[k] === 'function') Wrapped[k] = OrigPC[k].bind(OrigPC); } catch (e) {} });
      Wrapped.__wumpCallWrapped = true;
      window.RTCPeerConnection = Wrapped;
      try { window.webkitRTCPeerConnection = Wrapped; } catch (e) {}
      report(); // post initial (not-in-call) state so a reload clears any stale flag
    }
  } catch (e) {}

  // Unread / mention counts from the document title (e.g. "(3) Discord").
  function metrics() {
    const t = document.title || '';
    const m = t.match(/\\((\\d+)\\)/);
    const mentions = m ? parseInt(m[1], 10) : 0;
    const unread = mentions > 0 ? mentions : (/[•\\u2022]/.test(t) ? 1 : 0);
    post({ __wump: 'metrics', unread: unread, mentions: mentions });
  }
  // Connection / auth state.
  function hasLoginField() {
    return !!document.querySelector('input[name=email], input[type=email], input[autocomplete=username], input[autocomplete=email], input[name=password], input[type=password], input[autocomplete=current-password]');
  }
  function conn() {
    let state;
    if (!navigator.onLine) state = 'offline';
    else if (location.pathname.indexOf('/login') === 0 || hasLoginField()) state = 'signed-out';
    else state = 'connected';
    post({ __wump: 'conn', state: state });
  }
  function cssVar(style, names) {
    for (const name of names) {
      const v = style.getPropertyValue(name).trim();
      if (v) return v;
    }
    return '';
  }
  function theme() {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const name = Array.from(root.classList).find((c) => c.indexOf('theme-') === 0) || null;
    post({
      __wump: 'theme',
      name: name,
      appFrameBackground: cssVar(style, ['--app-frame-background']),
      bg: cssVar(style, ['--background-base-lowest', '--background-primary', '--bg-base-primary']),
      bg2: cssVar(style, ['--background-base-lower', '--background-secondary', '--bg-base-secondary']),
      bg3: cssVar(style, ['--background-base-low', '--background-tertiary', '--bg-base-tertiary']),
      bgHover: cssVar(style, ['--background-modifier-hover', '--bg-mod-faint']),
      text: cssVar(style, ['--text-primary', '--header-primary']),
      textDim: cssVar(style, ['--text-muted', '--text-secondary', '--header-secondary']),
      border: cssVar(style, ['--border-subtle', '--background-modifier-accent'])
    });
  }

  const start = () => {
    metrics(); conn(); theme();
    const titleEl = document.querySelector('title');
    if (titleEl) new MutationObserver(metrics).observe(titleEl, { childList: true, characterData: true, subtree: true });
    new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    setInterval(metrics, 5000);
    setInterval(conn, 5000);
    setInterval(theme, 5000);
    window.addEventListener('online', conn);
    window.addEventListener('offline', conn);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`;

webFrame.executeJavaScript(INJECT).catch(() => undefined);

// ---- login autofill (user-initiated, PIN-gated upstream) -----------------
// Filling the login form is the one place this preload writes to the page. It
// runs entirely in THIS isolated world (never the page's main world, so Discord
// scripts can't read the credentials) and only sets the standard email/password
// inputs via the native value setter + an `input` event so React picks them up.
// The user still solves any captcha/2FA and clicks Log In themselves.
function findField(selectors: string[]): HTMLInputElement | null {
  for (const selector of selectors) {
    const el = document.querySelector(selector) as HTMLInputElement | null;
    if (el) return el;
  }
  return null;
}

function fillField(selectors: string[], value: string): boolean {
  const el = findField(selectors);
  if (!el) return false;
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

ipcRenderer.on(IPC.obFill, (_e, p: { email?: string; password?: Uint8Array | null }) => {
  let pw = '';
  try {
    if (p.email) {
      retryFill([
        'input[name=email]',
        'input[type=email]',
        'input[autocomplete=username]',
        'input[autocomplete=email]',
      ], p.email);
    }
    if (p.password && p.password.length) {
      pw = new TextDecoder().decode(p.password);
      retryFill([
        'input[name=password]',
        'input[type=password]',
        'input[autocomplete=current-password]',
      ], pw);
    }
  } catch {
    /* ignore */
  } finally {
    // Best-effort wipe of the plaintext we held.
    pw = '';
    try { if (p.password) (p.password as Uint8Array).fill(0); } catch { /* ignore */ }
  }
});

function retryFill(selectors: string[], value: string) {
  let attempts = 0;
  const run = () => {
    attempts += 1;
    if (fillField(selectors, value) || attempts >= 40) return;
    window.setTimeout(run, 100);
  };
  run();
}

ipcRenderer.on(IPC.obPushToTalk, (_e, p: { enabled: boolean; pressed: boolean }) => {
  webFrame.executeJavaScript(
    `window.__wumpSetPushToTalk && window.__wumpSetPushToTalk(${JSON.stringify({
      enabled: !!p.enabled,
      pressed: !!p.pressed,
    })})`,
  ).catch(() => undefined);
});

ipcRenderer.on(IPC.obSoundConfig, (_e, p: { muteNotifSound: boolean }) => {
  webFrame.executeJavaScript(
    `window.__wumpSetSoundConfig && window.__wumpSetSoundConfig(${JSON.stringify({ muteNotifSound: !!p.muteNotifSound })})`,
  ).catch(() => undefined);
});

// Relay main-world messages (shared DOM EventTarget crosses isolated worlds).
window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as { __wump?: string; [k: string]: unknown };
  if (!d || typeof d !== 'object') return;
  if (d.__wump === 'notif') {
    ipcRenderer.send(IPC.obNotification, { accountId, title: d.title, body: d.body, kind: d.kind });
  } else if (d.__wump === 'metrics') {
    ipcRenderer.send(IPC.obMetrics, { accountId, unread: d.unread, mentions: d.mentions });
  } else if (d.__wump === 'theme') {
    ipcRenderer.send(IPC.obTheme, {
      accountId,
      name: d.name,
      appFrameBackground: d.appFrameBackground,
      bg: d.bg,
      bg2: d.bg2,
      bg3: d.bg3,
      bgHover: d.bgHover,
      text: d.text,
      textDim: d.textDim,
      border: d.border,
    });
  } else if (d.__wump === 'conn') {
    ipcRenderer.send(IPC.obConnection, { accountId, state: d.state });
  } else if (d.__wump === 'call') {
    ipcRenderer.send(IPC.obCall, { accountId, active: !!d.active });
  } else if (d.__wumpPlugin === 'broadcast') {
    // A `discord-view` plugin's content script broadcasting to its other
    // contexts. Least-trusted surface; main re-checks the plugin is enabled +
    // granted and treats the data as untrusted.
    ipcRenderer.send(IPC.obPluginMsg, { accountId, pluginId: String(d.pluginId ?? ''), channel: String(d.channel ?? ''), data: d.data });
  } else if (d.__wumpPlugin === 'error') {
    console.warn('[plugin-content]', d.pluginId, d.message);
  }
});
