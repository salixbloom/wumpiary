import React, { useCallback, useRef, useState } from 'react';
import { api } from './store';
import { useSidebarAnim } from './useSidebarAnim';
import { useT } from './i18n';
import { COLLAPSED_SIDEBAR_WIDTH } from '../shared/types';
import type { AccountConfig, AccountRuntime, AppState, ConnectionState } from '../shared/types';

interface SidebarProps {
  state: AppState;
  onOpenSettings: () => void;
  onOpenInbox: () => void;
}

export function Sidebar({ state, onOpenSettings, onOpenInbox }: SidebarProps) {
  const t = useT();
  const ui = state.config.ui;
  const collapsed = ui.sidebarCollapsed;
  const order = state.config.accountsOrder;
  const dragId = useRef<string | null>(null);

  // Footer: when collapsed the three actions live behind a single button that
  // unfurls a vertical list; `footOpen` tracks that list. The collapse/expand
  // transitions are scripted by the animation manager (see useSidebarAnim).
  const [footOpen, setFootOpen] = useState(false);
  const { anim, busy, footFall, toggle, sidebarRef } = useSidebarAnim();
  const collapsing = anim === 'collapsing';
  const expanding = anim === 'expanding';

  const drop = (targetId: string) => {
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === targetId) return;
    const next = order.filter((x) => x !== from);
    next.splice(next.indexOf(targetId), 0, from);
    api.reorder(next);
  };

  const toggleSidebar = () => toggle(collapsed, footOpen, () => setFootOpen(false));

  // Measure the ghost ⋯'s real footprint (its width + the 6px row gap) and feed
  // it to the footer as --slot, so the buttons slide exactly one slot left when it
  // is punched out — without forcing any button to a fixed width.
  const measureSlot = useCallback((el: HTMLButtonElement | null) => {
    if (el?.parentElement) el.parentElement.style.setProperty('--slot', `${el.getBoundingClientRect().width + 6}px`);
  }, []);

  const footActions: FootAction[] = [
    {
      key: 'dnd',
      title: t('sidebar.dnd'),
      className: `icon-btn ${state.config.global.dnd ? 'on' : ''}`,
      label: state.config.global.dnd ? '🔕' : '🔔',
      onClick: () => api.patchGlobal({ dnd: !state.config.global.dnd }),
    },
    { key: 'settings', title: t('sidebar.settings'), className: 'icon-btn', label: '⚙', onClick: onOpenSettings },
    { key: 'lock', title: t('sidebar.lock'), className: 'icon-btn', label: '🔒', onClick: () => api.lock(), disabled: !state.hasVault },
  ];

  return (
    <div
      ref={sidebarRef}
      className={`sidebar ${collapsed ? 'collapsed' : ''} ${busy ? 'busy' : ''} ${collapsing ? 'anim-collapsing' : ''} ${expanding ? 'anim-expanding' : ''}`}
      style={{
        width: collapsed ? COLLAPSED_SIDEBAR_WIDTH : ui.sidebarWidth,
        // Head choreography geometry: lay the head out at its final width while the
        // rail is still narrow, and how far left the inbox must reach to sit over
        // the toggle (its "obscure" target). See .sidebar.anim-expanding in css.
        ...(expanding ? { '--full-w': `${ui.sidebarWidth}px`, '--obscure': `${-(ui.sidebarWidth - 52)}px` } : {}),
      } as React.CSSProperties}
    >
      <div className="sidebar-head">
        <button className="icon-btn toggle-btn" title={t('sidebar.toggle')} onClick={toggleSidebar}>
          {ui.sidebarSide === 'right' ? (collapsed ? '‹' : '›') : collapsed ? '›' : '‹'}
        </button>
        {(!collapsed || collapsing || expanding) && <Brand walk={expanding} />}
        <button className="inbox-btn" title={t('sidebar.inbox')} onClick={onOpenInbox}>
          <InboxIcon />
          {state.activity.length > 0 && (
            <span className="inbox-badge">{state.activity.length > 99 ? '99+' : state.activity.length}</span>
          )}
        </button>
      </div>

      <div className="perches">
        {order.map((id, i) => (
          <Perch
            key={id}
            account={state.config.accounts[id]}
            runtime={state.runtime[id]}
            active={state.activeId === id}
            collapsed={collapsed}
            collapsing={collapsing}
            index={i}
            onClick={() => api.setActive(id)}
            onContext={(e) => { e.preventDefault(); api.showAccountMenu(id); }}
            onDragStart={() => (dragId.current = id)}
            onDrop={() => drop(id)}
          />
        ))}
        <button className="perch add" onClick={() => api.addAccount()} title={t('sidebar.addAccount')}>
          <span className="avatar add-avatar"><PlusIcon /></span>
          {!collapsed && <span className="perch-label">{t('sidebar.addAccount')}</span>}
        </button>
      </div>

      <div className="sidebar-foot">
        {collapsing ? (
          // Collapse transition: the three buttons shuffle into a deck (against
          // the footer centre, where the collapsed button ends up) and the expand
          // button is pulled from behind the pile, up over it, then dropped on top.
          // The rail is still full width here (the manager defers the shrink), so
          // each card starts from where its real button sits — `--startx` is that
          // button's centre offset from the footer centre. Layout: 10px padding,
          // 26px buttons, 6px gaps → centre = 23 + 32*i.
          <div className="foot-deck">
            {footActions.map((a, i) => (
              <span
                key={a.key}
                className="deck-card"
                style={{ '--i': i, '--startx': `${23 + 32 * i - ui.sidebarWidth / 2}px` } as React.CSSProperties}
              >
                <button className={a.className} title={a.title} disabled={a.disabled} tabIndex={-1}>
                  {a.label}
                </button>
              </span>
            ))}
            <span className="deck-card deck-top">
              <button className="icon-btn foot-more" tabIndex={-1}>⋯</button>
            </span>
          </div>
        ) : collapsed && !expanding ? (
          <div className="foot-collapsed">
            {footOpen && (
              <div className="foot-stack">
                {footActions.map((a) => (
                  <button
                    key={a.key}
                    className={a.className}
                    title={a.title}
                    disabled={a.disabled}
                    onClick={() => { setFootOpen(false); a.onClick(); }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
            <button
              className={`icon-btn foot-more ${footOpen ? 'open' : ''}`}
              title={t('sidebar.more')}
              onClick={() => setFootOpen((o) => !o)}
            >
              ⋯
            </button>
          </div>
        ) : (
          // Expand arrival into the horizontal row. `falling` (action list was
          // open) plays the matrix-fall; otherwise the plain `spread` lifts the
          // buttons out of the collapsed ⋯. Either way the ⋯ is preserved as a
          // ghost beneath them and the bell leans back then punches it out (see
          // .foot-row.expanding in styles.css).
          <div className={`foot-row ${expanding ? 'expanding' : ''} ${expanding ? (footFall ? 'falling' : 'spread') : ''}`}>
            {/* The preserved ⋯ sits leftmost (a real button) so the actions land one
                slot to its right; the bell punches it out and they slide left. */}
            {expanding && <button ref={measureSlot} className="icon-btn foot-more foot-ghost" tabIndex={-1} aria-hidden="true">⋯</button>}
            {footActions.map((a, i) => (
              <button
                key={a.key}
                className={`${a.className}${expanding && i === 0 ? ' foot-bell' : ''}`}
                title={a.title}
                disabled={a.disabled}
                style={expanding ? ({ '--i': i } as React.CSSProperties) : undefined}
                onClick={a.onClick}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface FootAction {
  key: string;
  title: string;
  className: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

function statusLabel(conn: ConnectionState, t: (key: string) => string): string {
  const map: Record<ConnectionState, string> = {
    connected: t('sidebar.status.connected'),
    reconnecting: t('sidebar.status.reconnecting'),
    offline: t('sidebar.status.offline'),
    hibernated: t('sidebar.status.hibernated'),
    'signed-out': t('sidebar.status.signedOut'),
    loading: t('sidebar.status.loading'),
  };
  return map[conn];
}

function Perch({
  account, runtime, active, collapsed, collapsing, index, onClick, onContext, onDragStart, onDrop,
}: {
  account: AccountConfig;
  runtime?: AccountRuntime;
  active: boolean;
  collapsed: boolean;
  collapsing: boolean;
  index: number;
  onClick: () => void;
  onContext: (e: React.MouseEvent) => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const t = useT();
  const conn = runtime?.connection ?? 'offline';
  const mentions = runtime?.mentions ?? 0;
  const unread = runtime?.unread ?? 0;
  const inCall = runtime?.inCall ?? false;
  // Shake the avatar when a notification was just surfaced here (a sound was made),
  // cleared once the account is opened — not a generic "has unread" indicator.
  const notifying = (runtime?.notifying ?? false) && !active;
  // Keep the full row (name/status + count) mounted while the rail is collapsing
  // so the avatar visibly travels over it as the rail shrinks. The compact count
  // bubble only appears once collapsed AND the collapse has finished, so it can
  // pop in as the downward wave (its delay keys off --idx in styles.css).
  const showRow = !collapsed || collapsing;
  const showBubble = collapsed && !collapsing && mentions > 0;
  return (
    <div
      className={`perch ${active ? 'active' : ''} ${inCall ? 'in-call' : ''}`}
      style={{ '--idx': index } as React.CSSProperties}
      onClick={onClick}
      onContextMenu={onContext}
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      title={collapsed ? account.nickname : undefined}
    >
      <div className={`avatar-wrap ${notifying ? 'shake' : ''}`}>
        <Avatar account={account} />
        <span className={`dot ${conn}`} title={statusLabel(conn, t)} />
        {account.notifications.muted && <span className="muted-overlay" title={t('sidebar.muted')}>🔇</span>}
        {showBubble && <span className="pill mention mini">{mentions}</span>}
      </div>
      {showRow && (
        <div className="perch-body">
          <span className="perch-label">{account.nickname}</span>
          <span className="perch-sub">{statusLabel(conn, t)}</span>
        </div>
      )}
      {showRow && (
        <div className="perch-counts">
          {mentions > 0 && <span className="pill mention">{mentions}</span>}
          {unread > 0 && mentions === 0 && <span className="pill unread">{unread}</span>}
        </div>
      )}
    </div>
  );
}

// The brand wordmark. When `walk` is set (expand choreography) each letter is its
// own span so it can bounce/squish into place on a stagger (--li); otherwise it's
// a plain label.
function Brand({ walk }: { walk: boolean }) {
  const text = 'wumpiary';
  if (!walk) return <span className="brand">{text}</span>;
  return (
    <span className="brand brand-walk" aria-label={text}>
      {text.split('').map((ch, i) => (
        <span key={i} className="brand-letter" style={{ '--li': i } as React.CSSProperties}>{ch}</span>
      ))}
    </span>
  );
}

function PlusIcon() {
  return (
    <svg className="add-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg className="inbox-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.6 9.3 4.2 4.1a1 1 0 0 1 .96-.7h5.68a1 1 0 0 1 .96.7l1.6 5.2" />
      <path d="M2.6 9.3h3.2l.8 1.5h2.8l.8-1.5h3.2v2.4a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function Avatar({ account }: { account: AccountConfig }) {
  if (account.avatarOverride) {
    return <img className="avatar" src={account.avatarOverride.startsWith('file:') ? account.avatarOverride : `file://${account.avatarOverride}`} alt={account.nickname} />;
  }
  const initials = account.nickname.trim().slice(0, 2).toUpperCase() || '??';
  return <span className="avatar" style={{ background: account.color }}>{initials}</span>;
}

