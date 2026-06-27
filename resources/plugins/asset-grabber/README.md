# Asset Grabber

Download the original-resolution file behind any Discord image — avatars, server
icons, custom emoji, stickers, and attached/embedded images — straight to your
computer.

## Setup

1. Enable **Asset Grabber** in Settings → Plugins.
2. Grant all three permissions:
   - **discord-view** — lets the Save button appear inside Discord (high-trust).
   - **network** — fetches the image bytes.
   - **files** — opens the native Save dialog to write the file.

## Usage

1. Open any Discord account view.
2. **Hover** an avatar, server icon, emoji, or image. A small **⤓ Save** chip
   appears over it.
3. **Click it.** A Save dialog opens — pick a location and the full-resolution
   file is written there.

## Notes

- Works only over Discord's own CDN images (`cdn.discordapp.com` /
  `media.discordapp.net`); other embedded images are ignored.
- The URL is upgraded to `size=4096` for the highest resolution Discord serves,
  and `.webp` is saved as `.png` by default.
- Tiny elements (under 16px) don't show the chip, to avoid clutter.
- If clicking Save does nothing, check that **network** and **files** are both
  granted.

## How it works

The button lives in a content script that can see the page but has no network or
disk access; it hands the URL to the plugin's headless half, which holds the
`network` + `files` capabilities and does the fetch + save. Each half has only
the access it needs.
