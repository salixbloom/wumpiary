// Shared sound-path resolution used by both the renderer's audio player
// (per-account notification chimes + push-to-talk sounds) and the main process.
// Kept dependency-free so any process can import it.

/** True if the value already carries a URL scheme (http:, file:, wumpiary:, data:, …). */
export function isSoundUrl(sound: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(sound);
}

/**
 * Resolve a user-configured sound value to a playable URL.
 * Returns `null` for the built-in default ('' / 'default') and for 'none', in
 * which case the caller decides the fallback (a default blip, or silence).
 * Bare filesystem paths are turned into `file://` URLs.
 */
export function resolveSoundUrl(sound: string): string | null {
  if (!sound || sound === 'default' || sound === 'none') return null;
  return isSoundUrl(sound) ? sound : `file://${sound}`;
}
