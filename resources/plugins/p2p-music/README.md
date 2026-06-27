# P2P Music

A peer-to-peer "listen together" music player. Load local tracks into a queue
and stream them — Opus-compressed — directly to a friend over WebRTC. There's no
server: you connect by copy-pasting a short invite/answer code.

## Setup

1. Enable **P2P Music** in Settings → Plugins.
2. Grant **network** (for the WebRTC connection) and **files** (to load tracks).
3. Click **Open P2P Music** on the plugin card to open the player window.

## Playing locally

- **＋ Add tracks…** loads audio files (mp3, ogg, opus, flac, wav, m4a, aac).
- Double-click a track to play it; use ⏮ / ▶ / ⏭ to control playback.

## Listening together

**Host (you share the music):**
1. Go to the **Host** tab and click **Create invite**.
2. Copy the invite code and send it to your friend.
3. Paste the **answer code** they send back into the lower box, then click
   **Connect**.

**Join (you listen):**
1. Go to the **Join** tab and paste the host's invite code.
2. Click **Generate answer**, copy the answer code, and send it back to the host.
3. Once they connect, the host's audio plays and the queue mirrors theirs.

## Notes

- **Experimental.** Best results are on the same network. A public STUN server is
  used to help peers find each other; strict NATs may not connect.
- Audio is compressed automatically by WebRTC's Opus encoder — no setup needed.
- The host controls playback and the shared queue; listeners follow along.
