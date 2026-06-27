# Content Warning

Blurs any message that contains one of your filtered words until you choose to
reveal it — useful for muting spoilers, triggering topics, or words you'd rather
not see at a glance.

## Setup

1. Enable **Content Warning** in Settings → Plugins.
2. Grant the **discord-view** permission (this is what lets the plugin read the
   message text inside Discord — it is the high-trust permission, so only keep it
   on for plugins you trust).
3. Click the **⚙ gear** on the plugin card to open the **Filters** panel.

## Usage

- In the Filters panel, type a word or phrase and press **Add**. Matching is
  case-insensitive and matches anywhere in the message.
- Remove a word with the **✕** next to it.
- Any message containing a filtered word is blurred with a
  **"⚠ Hidden by content warning — click to reveal"** overlay. Click it to reveal
  that single message.
- Changes apply live across all of your account views — no reload needed.

## Notes

- Only the message text is checked; embeds/attachments are blurred along with the
  message when its text matches.
- This plugin needs no network or file access — it only reads and hides text.
