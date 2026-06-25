import React, { useEffect, useRef, useState } from 'react';
import { api } from './store';
import type { AccountConfig, AccountRuntime, AppState, ConnectionState } from '../shared/types';

interface SidebarProps {
  state: AppState;
  onOpenSettings: () => void;
  onAccountSettings: (id: string) => void;
}

export function Sidebar({ state, onOpenSettings, onAccountSettings }: SidebarProps) {
  const ui = state.config.ui;
  const collapsed = ui.sidebarCollapsed;
  const order = state.config.accountsOrder;
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
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
        {!collapsed && state.totalMentions > 0 && <span className="brand-badge">{state.totalMentions}</span>}
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
            onContext={(e) => { e.preventDefault(); setMenu({ id, x: e.clientX, y: e.clientY }); }}
            onDragStart={() => (dragId.current = id)}
            onDrop={() => drop(id)}
          />
        ))}
        <button className="perch add" onClick={() => api.addAccount()} title="Add account">
          <span className="avatar add-avatar">+</span>
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

      {menu && (
        <ContextMenu
          account={state.config.accounts[menu.id]}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onSettings={() => onAccountSettings(menu.id)}
        />
      )}
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
  return (
    <div
      className={`perch ${active ? 'active' : ''}`}
      onClick={onClick}
      onContextMenu={onContext}
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      title={collapsed ? account.nickname : undefined}
    >
      <div className="avatar-wrap">
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

function Avatar({ account }: { account: AccountConfig }) {
  if (account.avatarOverride) {
    return <img className="avatar" src={account.avatarOverride.startsWith('file:') ? account.avatarOverride : `file://${account.avatarOverride}`} alt={account.nickname} />;
  }
  const initials = account.nickname.trim().slice(0, 2).toUpperCase() || '??';
  return <span className="avatar" style={{ background: account.color }}>{initials}</span>;
}

function ContextMenu({
  account, x, y, onClose, onSettings,
}: {
  account: AccountConfig;
  x: number;
  y: number;
  onClose: () => void;
  onSettings: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);

  const act = (fn: () => void) => () => { fn(); onClose(); };
  const snooze = (mins: number | 'tomorrow' | 'clear') => {
    if (mins === 'clear') return api.snooze(account.id, null);
    if (mins === 'tomorrow') {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return api.snooze(account.id, d.getTime());
    }
    return api.snooze(account.id, Date.now() + mins * 60_000);
  };

  return (
    <div className="context-menu" ref={ref} style={{ left: x, top: y }}>
      <div className="cm-title">{account.nickname}</div>
      <button onClick={act(() => api.updateAccount(account.id, { notifications: { muted: !account.notifications.muted } }))}>
        {account.notifications.muted ? 'Unmute notifications' : 'Mute notifications'}
      </button>
      <div className="cm-sub">Snooze</div>
      <div className="cm-row">
        <button onClick={act(() => snooze(15))}>15m</button>
        <button onClick={act(() => snooze(60))}>1h</button>
        <button onClick={act(() => snooze('tomorrow'))}>Tomorrow</button>
        <button onClick={act(() => snooze('clear'))}>Clear</button>
      </div>
      <hr />
      <button onClick={act(() => api.setHibernated(account.id, !account.hibernated))}>
        {account.hibernated ? 'Wake account' : 'Hibernate (save RAM, stops notifications)'}
      </button>
      <button onClick={act(() => api.reload(account.id))} disabled={account.hibernated}>Reload</button>
      <button onClick={act(onSettings)}>Account settings…</button>
      <button onClick={act(() => api.openDevtools(account.id))} disabled={account.hibernated}>Open devtools</button>
      <hr />
      <button onClick={act(() => api.signOut(account.id))}>Quick sign out (keep perch)</button>
      <button className="danger" onClick={act(() => { if (confirm(`Forget "${account.nickname}"? This wipes its session and removes it.`)) api.forget(account.id); })}>
        Forget account…
      </button>
    </div>
  );
}
