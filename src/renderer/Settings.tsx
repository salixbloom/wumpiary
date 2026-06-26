import React from 'react';
import { api } from './store';
import type { AppState, NotificationFilter, CallPolicy, Theme } from '../shared/types';
import { PERMISSION_LABELS } from '../shared/plugins';

export type SettingsTab = 'general' | 'account' | 'activity' | 'plugins' | 'about';

interface Props {
  state: AppState;
  tab: SettingsTab;
  accountId: string | null;
  onTab: (t: SettingsTab) => void;
  onSelectAccount: (id: string) => void;
  onClose: () => void;
}

export function Settings({ state, tab, accountId, onTab, onSelectAccount, onClose }: Props) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="modal-nav">
          <div className="modal-title">Settings</div>
          {(['general', 'account', 'activity', 'plugins', 'about'] as SettingsTab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => onTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
          <button className="modal-close" onClick={onClose}>Close ✕</button>
        </nav>
        <div className="modal-body">
          {tab === 'general' && <General state={state} />}
          {tab === 'account' && <AccountSettings state={state} accountId={accountId} onSelectAccount={onSelectAccount} />}
          {tab === 'activity' && <Activity state={state} />}
          {tab === 'plugins' && <Plugins state={state} />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="row">
      <div className="row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

function General({ state }: { state: AppState }) {
  const { ui, global } = state.config;
  return (
    <section>
      <h3>Appearance</h3>
      <Row label="Theme">
        <select value={ui.theme} onChange={(e) => api.patchUi({ theme: e.target.value as Theme })}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">Follow system</option>
        </select>
      </Row>
      <Row label="Accent colour">
        <input type="color" value={ui.accent} onChange={(e) => api.patchUi({ accent: e.target.value })} />
      </Row>
      <Row label="Sidebar side">
        <select value={ui.sidebarSide} onChange={(e) => api.patchUi({ sidebarSide: e.target.value as 'left' | 'right' })}>
          <option value="right">Right</option>
          <option value="left">Left</option>
        </select>
      </Row>
      <Row label="Sidebar width" hint="expanded">
        <input type="range" min={180} max={360} value={ui.sidebarWidth} onChange={(e) => api.patchUi({ sidebarWidth: +e.target.value })} />
      </Row>

      <h3>Notifications</h3>
      <Row label="Do Not Disturb" hint="mute all accounts">
        <Toggle on={global.dnd} onChange={(v) => api.patchGlobal({ dnd: v })} />
      </Row>
      <Row label="Hide message previews" hint="show 'New message' only">
        <Toggle on={global.hidePreviews} onChange={(v) => api.patchGlobal({ hidePreviews: v })} />
      </Row>

      <h3>Startup &amp; security</h3>
      <Row label="Launch at login">
        <Toggle on={global.autoLaunch} onChange={(v) => api.patchGlobal({ autoLaunch: v })} />
      </Row>
      <Row label="Start minimized to tray">
        <Toggle on={global.startMinimized} onChange={(v) => api.patchGlobal({ startMinimized: v })} />
      </Row>
      <Row label="Auto-lock when idle">
        <select value={global.autoLockMinutes} onChange={(e) => api.patchGlobal({ autoLockMinutes: +e.target.value })}>
          <option value={0}>Off</option>
          <option value={5}>5 min</option>
          <option value={15}>15 min</option>
          <option value={30}>30 min</option>
          <option value={60}>1 hour</option>
        </select>
      </Row>

      <h3>Resources</h3>
      <Row label="Auto-hibernate inactive accounts" hint="reclaims RAM; hibernated accounts stop notifying">
        <select value={global.autoHibernateMinutes} onChange={(e) => api.patchGlobal({ autoHibernateMinutes: +e.target.value })}>
          <option value={0}>Off (stay connected)</option>
          <option value={30}>After 30 min</option>
          <option value={60}>After 1 hour</option>
          <option value={180}>After 3 hours</option>
        </select>
      </Row>
      <p className="note">Connected accounts stay live in the background (their gateway never sleeps), and only the active one is rendered. Hibernation is the only way to free an account's memory — at the cost of its notifications.</p>
    </section>
  );
}

function AccountSettings({ state, accountId, onSelectAccount }: { state: AppState; accountId: string | null; onSelectAccount: (id: string) => void }) {
  const id = accountId && state.config.accounts[accountId] ? accountId : state.config.accountsOrder[0];
  const acc = id ? state.config.accounts[id] : null;
  if (!acc) return <p className="note">No accounts yet. Add one from the sidebar.</p>;
  const n = acc.notifications;
  return (
    <section>
      <Row label="Account">
        <select value={id} onChange={(e) => onSelectAccount(e.target.value)}>
          {state.config.accountsOrder.map((aid) => (
            <option key={aid} value={aid}>{state.config.accounts[aid].nickname}</option>
          ))}
        </select>
      </Row>

      <h3>Identity</h3>
      <Row label="Nickname">
        <input value={acc.nickname} onChange={(e) => api.updateAccount(id, { nickname: e.target.value })} />
      </Row>
      <Row label="Colour tag">
        <input type="color" value={acc.color} onChange={(e) => api.updateAccount(id, { color: e.target.value })} />
      </Row>
      <Row label="Custom avatar" hint="file path, optional">
        <input placeholder="/path/to/image.png" value={acc.avatarOverride ?? ''} onChange={(e) => api.updateAccount(id, { avatarOverride: e.target.value || null })} />
      </Row>

      <h3>Notifications</h3>
      <Row label="Mute">
        <Toggle on={n.muted} onChange={(v) => api.updateAccount(id, { notifications: { muted: v } })} />
      </Row>
      <Row label="Filter">
        <select value={n.filter} onChange={(e) => api.updateAccount(id, { notifications: { filter: e.target.value as NotificationFilter } })}>
          <option value="all">All messages</option>
          <option value="mentions+dms">Mentions &amp; DMs</option>
          <option value="mentions">Mentions only</option>
          <option value="dms">DMs only</option>
          <option value="none">Nothing</option>
        </select>
      </Row>
      <Row label="Hide previews">
        <Toggle on={n.hidePreview} onChange={(v) => api.updateAccount(id, { notifications: { hidePreview: v } })} />
      </Row>
      <Row label="Custom chime" hint="file path; blank = default blip">
        <input placeholder="default" value={n.chime === 'default' ? '' : n.chime} onChange={(e) => api.updateAccount(id, { notifications: { chime: e.target.value || 'default' } })} />
      </Row>

      <h3>Calls</h3>
      <Row label="Call policy">
        <select value={acc.calls.policy} onChange={(e) => api.updateAccount(id, { calls: { policy: e.target.value as CallPolicy } })}>
          <option value="allow">Allow (popup + ringtone)</option>
          <option value="muted">Notify but muted</option>
          <option value="silent">Silent (counter only)</option>
          <option value="block">Block call notifications</option>
        </select>
      </Row>

      <h3>Privacy</h3>
      <Row label="Proxy" hint="e.g. socks5://host:port — for privacy, not ban evasion">
        <input placeholder="none" value={acc.proxy ?? ''} onChange={(e) => api.updateAccount(id, { proxy: e.target.value || null })} />
      </Row>
    </section>
  );
}

function Activity({ state }: { state: AppState }) {
  return (
    <section>
      <div className="row">
        <h3>Recent notifications</h3>
        <button onClick={() => api.clearActivity()}>Clear</button>
      </div>
      {state.activity.length === 0 && <p className="note">Nothing yet.</p>}
      <ul className="activity">
        {state.activity.map((a) => (
          <li key={a.id}>
            <span className="act-acct">{a.nickname}</span>
            <span className={`act-kind ${a.kind}`}>{a.kind}</span>
            <span className="act-title">{a.title}</span>
            <span className="act-body">{a.body}</span>
            <span className="act-time">{new Date(a.at).toLocaleTimeString()}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Plugins({ state }: { state: AppState }) {
  const plugins = state.plugins ?? [];
  return (
    <section>
      <div className="row">
        <h3>Plugins</h3>
        <span>
          <button onClick={() => api.openPluginsFolder()}>Open folder</button>{' '}
          <button onClick={() => api.reloadPlugins()}>Reload</button>
        </span>
      </div>
      <p className="note">
        Plugins extend wumpiary's own shell — they run sandboxed (no network, no file access) and can never run code inside Discord.
        Drop a plugin folder into the plugins directory, then reload. Only enable plugins you trust; grant each permission deliberately.
      </p>
      {plugins.length === 0 && <p className="note">No plugins installed.</p>}
      <ul className="plugins">
        {plugins.map((p) => (
          <li key={p.id} className={`plugin ${p.error ? 'has-error' : ''}`}>
            <div className="plugin-head">
              <div className="plugin-id">
                <span className="plugin-name">{p.name}</span>
                <span className="plugin-version">v{p.version}</span>
                {p.author && <span className="plugin-author">by {p.author}</span>}
              </div>
              <Toggle on={p.enabled} onChange={(v) => api.setPluginEnabled(p.id, v)} />
            </div>
            {p.description && <p className="plugin-desc">{p.description}</p>}
            {p.error && <p className="plugin-error">⚠ {p.error}</p>}
            {p.permissions.length > 0 && (
              <div className="plugin-perms">
                <small>Permissions</small>
                {p.permissions.map((perm) => (
                  <div key={perm.name} className="row perm-row">
                    <div className="row-label">
                      <span>{perm.name}</span>
                      <small>{PERMISSION_LABELS[perm.name]}</small>
                    </div>
                    <div className="row-control">
                      <Toggle on={perm.granted} onChange={(v) => api.setPluginPermission(p.id, perm.name, v)} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function About() {
  return (
    <section className="about">
      <h3>wumpiary</h3>
      <p>A home for many Wumpuses. Runs multiple Discord accounts at once — each in its own isolated, persistent session — so notifications from every account arrive together.</p>
      <p>It loads the genuine Discord web client and observes only; it never automates accounts or modifies Discord.</p>
      <h3>Security</h3>
      <p>Your PIN gates an encrypted vault (scrypt + AES-256-GCM, bound to the OS keychain where available). This protects against casual local access — not a determined attacker with full disk access to a running session.</p>
    </section>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="knob" />
    </button>
  );
}
