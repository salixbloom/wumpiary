import React, { useRef } from 'react';
import { api } from './store';
import type { AccountConfig, AccountRuntime, AppState, ConnectionState } from '../shared/types';

interface SidebarProps {
  state: AppState;
  onOpenSettings: () => void;
  onOpenInbox: () => void;
}

export function Sidebar({ state, onOpenSettings, onOpenInbox }: SidebarProps) {
  const ui = state.config.ui;
  const collapsed = ui.sidebarCollapsed;
  const order = state.config.accountsOrder;
  const dragId = useRef<string | null>(null);

  const drop = (targetId: string) => {
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === targetId) return;
    const next = order.filter((x) => x !== from);
    next.splice(next.indexOf(targetId), 0, from);
    api.reorder(next);
  };

  return (
    <div className="sidebar" style={{ width: collapsed ? 64 : ui.sidebarWidth }}>
      <div className="sidebar-head">
        <button className="icon-btn" title="Toggle sidebar" onClick={() => api.patchUi({ sidebarCollapsed: !collapsed })}>
          {ui.sidebarSide === 'right' ? (collapsed ? '‹' : '›') : collapsed ? '›' : '‹'}
        </button>
        {!collapsed && <span className="brand">wumpiary</span>}
        <button className="inbox-btn" title="Inbox — notifications from all accounts" onClick={onOpenInbox}>
          <InboxIcon />
          {state.activity.length > 0 && (
            <span className="inbox-badge">{state.activity.length > 99 ? '99+' : state.activity.length}</span>
          )}
        </button>
      </div>

      <div className="perches">
        {order.map((id) => (
          <Perch
            key={id}
            account={state.config.accounts[id]}
            runtime={state.runtime[id]}
            active={state.activeId === id}
            collapsed={collapsed}
            onClick={() => api.setActive(id)}
            onContext={(e) => { e.preventDefault(); api.showAccountMenu(id); }}
            onDragStart={() => (dragId.current = id)}
            onDrop={() => drop(id)}
          />
        ))}
        <button className="perch add" onClick={() => api.addAccount()} title="Add account">
          <span className="avatar add-avatar"><PlusIcon /></span>
          {!collapsed && <span className="perch-label">Add account</span>}
        </button>
      </div>

      <div className="sidebar-foot">
        <button className={`icon-btn ${state.config.global.dnd ? 'on' : ''}`} title="Do Not Disturb (mute all)" onClick={() => api.patchGlobal({ dnd: !state.config.global.dnd })}>
          {state.config.global.dnd ? '🔕' : '🔔'}
        </button>
        <button className="icon-btn" title="Settings" onClick={onOpenSettings}>⚙</button>
        <button className="icon-btn" title="Lock" disabled={!state.hasVault} onClick={() => api.lock()}>🔒</button>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<ConnectionState, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
  hibernated: 'Hibernated (not notifying)',
  'signed-out': 'Signed out',
  loading: 'Loading…',
};

function Perch({
  account, runtime, active, collapsed, onClick, onContext, onDragStart, onDrop,
}: {
  account: AccountConfig;
  runtime?: AccountRuntime;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
  onContext: (e: React.MouseEvent) => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const conn = runtime?.connection ?? 'offline';
  const mentions = runtime?.mentions ?? 0;
  const unread = runtime?.unread ?? 0;
  const inCall = runtime?.inCall ?? false;
  // Shake the avatar when a notification was just surfaced here (a sound was made),
  // cleared once the account is opened — not a generic "has unread" indicator.
  const notifying = (runtime?.notifying ?? false) && !active;
  return (
    <div
      className={`perch ${active ? 'active' : ''} ${inCall ? 'in-call' : ''}`}
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
        <span className={`dot ${conn}`} title={STATUS_LABEL[conn]} />
        {account.notifications.muted && <span className="muted-overlay" title="Muted">🔇</span>}
        {collapsed && mentions > 0 && <span className="pill mention mini">{mentions}</span>}
      </div>
      {!collapsed && (
        <div className="perch-body">
          <span className="perch-label">{account.nickname}</span>
          <span className="perch-sub">{STATUS_LABEL[conn]}</span>
        </div>
      )}
      {!collapsed && (
        <div className="perch-counts">
          {mentions > 0 && <span className="pill mention">{mentions}</span>}
          {unread > 0 && mentions === 0 && <span className="pill unread">{unread}</span>}
        </div>
      )}
    </div>
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

