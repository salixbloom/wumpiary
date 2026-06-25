import { Notification } from 'electron';
import { randomUUID } from 'crypto';
import { ConfigStore } from './config';
import { ActivityEntry, NotificationFilter, NotifKind } from '../shared/types';

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
    const notif = new Notification({
      title: `${acc.nickname} — ${p.title}`,
      body: hide ? (p.kind === 'call' ? 'Incoming call' : 'New message') : p.body,
      silent: true, // we drive sound ourselves via per-account chimes
    });
    notif.on('click', () => this.onActivate(p.accountId));
    notif.show();

    if (!silent) this.playChime(p.accountId, p.kind === 'call' ? acc.calls.ringtone : n.chime);
  }
}
