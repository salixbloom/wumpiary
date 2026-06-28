# P2P Music

A peer-to-peer "listen together" music player. Load local tracks into a queue
and stream them — Opus-compressed — live to your friends over WebRTC. There's no
server: you connect by copy-pasting a short invite/answer code.

## Setup

1. Enable **P2P Music** in Settings → Plugins.
2. Grant **network** (for the WebRTC connection) and **files** (to load tracks).
   Grant **discord-view** as well to use **Quick connect** (below); it's optional
   — the manual code flow works without it.
3. Click **Open P2P Music** on the plugin card to open the player window.

## Playing locally

- **＋ Add tracks…** loads audio files (mp3, ogg, opus, flac, wav, m4a, aac).
- Double-click a track to play it; use ⏮ / ▶ / ⏭ to control playback.
- The **volume slider** runs 0–200% with **100% at the centre**; click the
  speaker icon to quick-mute. Volume is local to you and never changes what
  other listeners hear.

## Listening together

Use **Session config** (a collapsible menu, host only) to decide what listeners
may do: pause, skip, queue, remove, and whether skipping is a **vote** (a
majority of listeners skips the track). **Connected** shows everyone listening.

### Quick connect (via Discord)

The fastest way, if both of you run this plugin and share a Discord chat:

1. **Host:** open the Discord chat you share with your friend, then click
   **📨 Invite via Discord**. The plugin posts a `plugin://p2p-…` invite message
   into that chat. (You won't see a Join button on your own invite.)
2. **Friend:** the message shows a **🎧 Join listening session** button — click
   it. Your machine posts its answer back automatically.
3. **Host:** your machine reads that answer automatically and connects. Click
   **Invite via Discord** again for each additional listener.

Nothing is sent without your action — the host clicks Invite, the listener clicks
Join. Everything else (generating the codes, posting the answer, reading it back)
is handled for you. Needs the **discord-view** permission on both sides.

### Manual codes (fallback)

Open the **Manual codes** menu if you'd rather copy-paste (e.g. no shared Discord
chat, or a code too long for one message):

- **Host:** **Create invite**, send the code, paste the **answer** they send
  back, then **Connect**. Repeat per listener.
- **Join:** paste the host's invite code, **Generate answer**, and send the
  answer back to the host.

### As a listener

The host's audio plays live and the queue mirrors theirs. Your transport
controls are enabled only for the actions the host allowed. If queueing is
allowed, **＋ Add tracks…** uploads a local file to the host, who adds it to the
shared queue and streams it to everyone when it plays.

## Notes

- **Experimental.** Best results are on the same network. A public STUN server is
  used to help peers find each other; strict NATs may not connect.
- Audio is streamed in real time (WebRTC's Opus encoder) — playback starts
  immediately and the whole file is never downloaded by listeners.
- Connection codes are the WebRTC offer/answer (there's no way around exchanging
  them serverlessly). They're trimmed of TCP ICE candidates and deflate-compressed
  to stay short enough for a single Discord message; if one is ever too long for
  Quick connect, use the **Manual codes** fallback.
- Files uploaded by listeners live in an ephemeral host-side store: capped at 10,
  dropped 5 minutes after they leave the queue, and cleared at the start and end
  of every session.
- The host is authoritative over playback and the shared queue; listeners act
  only within the permissions the host granted.
