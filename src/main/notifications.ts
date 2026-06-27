import { Notification, nativeImage } from 'electron';
import { randomUUID } from 'crypto';
import { ConfigStore } from './config';
import { AccountConfig, ActivityEntry, NotificationFilter, NotifKind } from '../shared/types';

/** Build a toast icon from an account's custom avatar (file path or data URL). */
function accountIcon(acc: AccountConfig) {
  const src = acc.avatarOverride;
  if (!src) return undefined;
  try {
    const img = src.startsWith('data:')
      ? nativeImage.createFromDataURL(src)
      : nativeImage.createFromPath(src.replace(/^file:\/\//, ''));
    return img.isEmpty() ? undefined : img;
  } catch {
    return undefined;
  }
}

export interface ObserverNotification {
  accountId: string;
  title: string;
  body: string;
  kind: NotifKind;
}

function passesFilter(filter: NotificationFilter, kind: NotifKind): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'none':
      return false;
    case 'mentions':
      return kind === 'mention';
    case 'dms':
      return kind === 'dm';
    case 'mentions+dms':
      return kind === 'mention' || kind === 'dm';
  }
}

/**
 * Applies per-account + global rules to observed notifications: mute, snooze,
 * global DND, filter, privacy/preview-hiding, call policy, and account tagging.
 */
export class NotificationRouter {
  constructor(
    private cfg: ConfigStore,
    private onActivate: (accountId: string) => void,
    private playChime: (accountId: string, chime: string) => void,
    private addActivity: (entry: ActivityEntry) => void,
    // Fired when a notification is actually surfaced (post-suppression), for
    // plugins holding the `notifications` permission.
    private onShown: (p: { accountId: string; nickname: string; title: string; body: string; kind: NotifKind }) => void = () => undefined,
  ) {}

  handle(p: ObserverNotification) {
    const c = this.cfg.get();
    const acc = c.accounts[p.accountId];
    if (!acc) return;

    // Activity log records everything, regardless of suppression.
    this.addActivity({ id: randomUUID(), accountId: p.accountId, nickname: acc.nickname, title: p.title, body: p.body, kind: p.kind, at: Date.now() });

    const n = acc.notifications;
    if (n.muted || c.global.dnd) return;
    if (n.snoozeUntil && Date.now() < n.snoozeUntil) return;

    let silent = false;
    if (p.kind === 'call') {
      switch (acc.calls.policy) {
        case 'block':
        case 'silent':
          return; // no popup
        case 'muted':
          silent = true;
          break;
        case 'allow':
          break;
      }
    } else if (!passesFilter(n.filter, p.kind)) {
      return;
    }

    const hide = n.hidePreview || c.global.hidePreviews;
    try {
      const notif = new Notification({
        title: `${acc.nickname} — ${p.title}`,
        body: hide ? (p.kind === 'call' ? 'Incoming call' : 'New message') : p.body,
        icon: accountIcon(acc), // show which account it came from
        silent: true, // we drive sound ourselves via per-account chimes
      });
      notif.on('click', () => this.onActivate(p.accountId));
      notif.on('failed', (_e, err) => console.warn('[notif] show failed:', err));
      notif.show();
    } catch (e) {
      console.error('[notif] error constructing/showing:', e);
    }
    this.onShown({ accountId: p.accountId, nickname: acc.nickname, title: p.title, body: p.body, kind: p.kind });

    // Sound policy:
    //  - default sound: play nothing — Discord plays its own notification sound,
    //    so a wumpiary chime would just double it up.
    //  - custom sound: play our chime; the observer mutes Discord's own sound for
    //    this account so only the custom chime is heard.
    const sound = p.kind === 'call' ? acc.calls.ringtone : n.chime;
    if (!silent && isCustomSound(sound)) this.playChime(p.accountId, sound);
  }
}

/** A user-overridden sound (not the built-in default and not 'none'/empty). */
export function isCustomSound(sound: string): boolean {
  return !!sound && sound !== 'default' && sound !== 'none';
}
