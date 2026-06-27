import React from 'react';
import { api } from './store';
import type { AppState, NotificationFilter, CallPolicy, Theme, GlobalConfig, AccountConfig } from '../shared/types';
import { PERMISSION_LABELS, HIGH_TRUST_PERMISSIONS, AUTOMATION_WARNING_TEXT } from '../shared/plugins';
import type { PluginInfo } from '../shared/plugins';

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

      <h3>Voice</h3>
      <Row label="Push to Talk" hint="gates the microphone while Discord uses voice activity">
        <Toggle on={global.pushToTalk.enabled} onChange={(v) => api.patchGlobal({ pushToTalk: { enabled: v } })} />
      </Row>
      <Row label="Push to Talk key">
        <HotkeyCapture value={global.pushToTalk} onChange={(pushToTalk) => api.patchGlobal({ pushToTalk })} />
      </Row>
      <Row label="Activation sound" hint="file path; blank = bundled sound">
        <input
          placeholder="default"
          value={global.pushToTalk.activateSound === 'default' ? '' : global.pushToTalk.activateSound}
          onChange={(e) => api.patchGlobal({ pushToTalk: { activateSound: e.target.value || 'default' } })}
        />
      </Row>
      <Row label="Deactivation sound" hint="file path; blank = bundled sound">
        <input
          placeholder="default"
          value={global.pushToTalk.deactivateSound === 'default' ? '' : global.pushToTalk.deactivateSound}
          onChange={(e) => api.patchGlobal({ pushToTalk: { deactivateSound: e.target.value || 'default' } })}
        />
      </Row>
      {global.pushToTalk.enabled && (
        <p className="note">{pushToTalkStatusText(state)}</p>
      )}

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

function pushToTalkStatusText(state: AppState) {
  const status = state.pushToTalkStatus;
  if (status.active) return 'Global key capture is active.';
  if (status.error) return `Global key capture is unavailable: ${status.error}`;
  return 'Using focused-window key capture until global key capture starts.';
}

function HotkeyCapture({
  value,
  onChange,
}: {
  value: GlobalConfig['pushToTalk'];
  onChange: (value: Partial<GlobalConfig['pushToTalk']>) => void;
}) {
  const [recording, setRecording] = React.useState(false);
  const ignoreNextClick = React.useRef(false);
  const capture = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!recording || e.type !== 'keydown') return;
    e.preventDefault();
    e.stopPropagation();
    ignoreNextClick.current = true;
    if (e.code === 'Escape') {
      setRecording(false);
      return;
    }
    if (isModifierCode(e.code)) return;
    onChange({
      key: e.code,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: false,
    });
    setRecording(false);
  };
  return (
    <button
      type="button"
      className={`hotkey-capture ${recording ? 'recording' : ''}`}
      onClick={() => {
        if (ignoreNextClick.current) {
          ignoreNextClick.current = false;
          return;
        }
        setRecording(true);
      }}
      onKeyDown={capture}
      onBlur={() => setRecording(false)}
    >
      {recording ? 'Press key combo...' : formatHotkey(value)}
    </button>
  );
}

function formatHotkey(value: GlobalConfig['pushToTalk']) {
  const parts = [
    value.ctrl && 'Ctrl',
    value.alt && 'Alt',
    value.shift && 'Shift',
    readableKey(value.key),
  ].filter(Boolean);
  return parts.join(' + ');
}

function readableKey(code: string) {
  if (code === 'Space') return 'Space';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function isModifierCode(code: string) {
  return code === 'ControlLeft' || code === 'ControlRight' || code === 'AltLeft' || code === 'AltRight' || code === 'ShiftLeft' || code === 'ShiftRight' || code === 'MetaLeft' || code === 'MetaRight';
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

      <h3>Saved login</h3>
      <SavedLogin accountId={id} saved={state.savedLogins?.[id]} />
    </section>
  );
}

function SavedLogin({ accountId, saved }: { accountId: string; saved?: { email: boolean; password: boolean } }) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [pin, setPin] = React.useState('');
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const save = async () => {
    if (!pin || (!email && !password) || busy) return;
    setBusy(true); setMsg(null);
    const r = await api.saveLogin(accountId, email, password, pin);
    setBusy(false);
    setPassword(''); setPin('');
    setMsg(r.ok ? 'Saved.' : 'Incorrect PIN — not saved.');
  };
  const clear = async () => { await api.clearLogin(accountId); setMsg('Cleared.'); };

  return (
    <>
      <p className="note">
        Optional. Lets you autofill the login when Discord signs this account out. Your email is kept in the encrypted vault;
        your password is additionally encrypted under your PIN, so autofilling always re-asks for it. You still click Log In and
        solve any captcha / 2FA yourself — nothing is submitted automatically.
      </p>
      <p className="note">
        Currently saved: email {saved?.email ? '✓' : '—'}, password {saved?.password ? '✓' : '—'}.
      </p>
      <Row label="Email">
        <input type="email" placeholder={saved?.email ? '•••• (saved)' : 'name@example.com'} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
      </Row>
      <Row label="Password" hint="encrypted under your PIN">
        <input type="password" placeholder={saved?.password ? '•••• (saved)' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
      </Row>
      <Row label="Confirm PIN" hint="required to encrypt/save">
        <input type="password" inputMode="numeric" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="off" />
      </Row>
      <div className="login-actions">
        <button className="primary" onClick={save} disabled={!pin || (!email && !password) || busy}>{busy ? 'Saving…' : 'Save login'}</button>
        {(saved?.email || saved?.password) && <button className="danger" onClick={clear}>Clear saved login</button>}
        {msg && <small className="note">{msg}</small>}
      </div>
    </>
  );
}

function ActAvatar({ account, nickname }: { account?: AccountConfig; nickname: string }) {
  if (account?.avatarOverride) {
    const src = account.avatarOverride.startsWith('file:') ? account.avatarOverride : `file://${account.avatarOverride}`;
    return <img className="act-avatar" src={src} alt={nickname} />;
  }
  const initials = (account?.nickname ?? nickname).trim().slice(0, 2).toUpperCase() || '??';
  return <span className="act-avatar" style={{ background: account?.color ?? 'var(--grey)' }}>{initials}</span>;
}

function Activity({ state }: { state: AppState }) {
  return (
    <section>
      <div className="row">
        <h3>Inbox — notifications from all accounts</h3>
        <button className="secondary" onClick={() => api.clearActivity()}>Clear</button>
      </div>
      {state.activity.length === 0 && <p className="note">Nothing yet.</p>}
      <ul className="activity">
        {state.activity.map((a) => (
          <li key={a.id}>
            <ActAvatar account={state.config.accounts[a.accountId]} nickname={a.nickname} />
            <span className="act-acct">{a.nickname}</span>
            <span className={`act-kind ${a.kind}`}>{a.kind}</span>
            <span className="act-title">{a.title}</span>
            <span className="act-time">{new Date(a.at).toLocaleTimeString()}</span>
            <span className="act-body">{a.body}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Plugins({ state }: { state: AppState }) {
  const plugins = state.plugins ?? [];
  // A subpage rendered on top of the list: a plugin's config panel, or its README.
  const [sub, setSub] = React.useState<{ kind: 'config' | 'help'; id: string } | null>(null);
  const subPlugin = sub ? plugins.find((p) => p.id === sub.id) ?? null : null;

  if (sub && subPlugin) {
    if (sub.kind === 'config') return <PluginConfig p={subPlugin} onBack={() => setSub(null)} />;
    return <PluginHelp p={subPlugin} onBack={() => setSub(null)} />;
  }

  return (
    <section>
      <div className="row">
        <h3>Plugins</h3>
        <span className="btn-row">
          <button className="secondary" onClick={() => api.openPluginsFolder()}>Open folder</button>
          <button className="secondary" onClick={() => api.reloadPlugins()}>Reload</button>
        </span>
      </div>
      <p className="note">
        Plugins extend wumpiary's own shell. They run sandboxed (no Node) and are disabled by default; each capability is granted individually.
        Some can reach the network, read/write files you choose, or — with the high-trust <b>discord-view</b> permission — run a content script
        inside Discord. Drop a plugin folder into the plugins directory, then reload. Only enable plugins you trust.
      </p>
      {plugins.length === 0 && <p className="note">No plugins installed.</p>}
      <ul className="plugins">
        {plugins.map((p) => (
          <PluginCard key={p.id} p={p} onConfig={() => setSub({ kind: 'config', id: p.id })} onHelp={() => setSub({ kind: 'help', id: p.id })} />
        ))}
      </ul>
    </section>
  );
}

function PluginCard({ p, onConfig, onHelp }: { p: PluginInfo; onConfig: () => void; onHelp: () => void }) {
  const m = p.metadata ?? {};
  return (
    <li className={`plugin ${p.error ? 'has-error' : ''}`}>
      <div className="plugin-head">
        <div className="plugin-id">
          <span className="plugin-name">{p.name}</span>
          <span className="plugin-version">v{p.version}</span>
          {p.author && <span className="plugin-author">by {p.author}</span>}
          {m.automationWarning && (
            <span className="plugin-badge warn" title={AUTOMATION_WARNING_TEXT} aria-label={AUTOMATION_WARNING_TEXT}>⚠ automation</span>
          )}
          {m.experimental && <span className="plugin-badge exp" title="May be unstable or change between versions.">experimental</span>}
          {(m.tags ?? []).map((t) => (
            <span key={t} className="plugin-badge tag">{t}</span>
          ))}
        </div>
        <div className="plugin-actions">
          {p.ui.hasReadme && <button className="icon-btn" title="How to use this plugin" aria-label="Help" onClick={onHelp}>?</button>}
          {p.enabled && p.ui.hasPanel && <button className="icon-btn" title={`Configure ${p.name}`} aria-label="Configure" onClick={onConfig}>⚙</button>}
          <Toggle on={p.enabled} onChange={(v) => api.setPluginEnabled(p.id, v)} />
        </div>
      </div>
      {p.description && <p className="plugin-desc">{p.description}</p>}
      {p.error && <p className="plugin-error">⚠ {p.error}</p>}
      {p.enabled && p.ui.hasWindow && (
        <div className="plugin-ui-row">
          <button className="secondary" onClick={() => api.openPluginWindow(p.id)}>Open {p.ui.windowTitle ?? 'window'}</button>
        </div>
      )}
      {p.permissions.length > 0 && (
        <div className="plugin-perms">
          <small>Permissions</small>
          {p.permissions.map((perm) => (
            <div key={perm.name} className={`row perm-row ${HIGH_TRUST_PERMISSIONS.includes(perm.name) ? 'high-trust' : ''}`}>
              <div className="row-label">
                <span>{perm.name}{HIGH_TRUST_PERMISSIONS.includes(perm.name) && <span className="perm-flag" title="High-trust capability — only grant to plugins you fully trust.">high trust</span>}</span>
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
  );
}

// Config subpage: hosts the plugin's panel.html as a native view positioned over
// the placeholder div. The view's lifetime is bound to this component, so it can
// never linger over the rest of the UI (the old softlock). Back returns to the list.
function PluginConfig({ p, onBack }: { p: PluginInfo; onBack: () => void }) {
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    api.openPluginPanel(p.id);
    const send = () => {
      const r = host.current?.getBoundingClientRect();
      if (r) api.setPluginPanelBounds(p.id, r.left, r.top, r.width, r.height);
    };
    send();
    const ro = new ResizeObserver(send);
    if (host.current) ro.observe(host.current);
    window.addEventListener('resize', send);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', send);
      api.closePluginPanel(p.id);
    };
  }, [p.id]);
  return (
    <section className="plugin-subpage">
      <div className="plugin-subhead">
        <button className="secondary" onClick={onBack}>← Back</button>
        <h3>{p.name} · {p.ui.panelTitle ?? 'settings'}</h3>
      </div>
      <div className="plugin-config-host" ref={host}>Loading…</div>
    </section>
  );
}

// Help subpage: renders the plugin's README.md (rendered by us as markdown — no
// plugin code runs here).
function PluginHelp({ p, onBack }: { p: PluginInfo; onBack: () => void }) {
  const [md, setMd] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    api.getPluginReadme(p.id).then((t) => { if (alive) setMd(t ?? ''); });
    return () => { alive = false; };
  }, [p.id]);
  return (
    <section className="plugin-subpage">
      <div className="plugin-subhead">
        <button className="secondary" onClick={onBack}>← Back</button>
        <h3>{p.name} · help</h3>
      </div>
      {md === null && <p className="note">Loading…</p>}
      {md === '' && <p className="note">This plugin has no README.md.</p>}
      {md && <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }} />}
    </section>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal, safe markdown -> HTML (escape first, then format). Links render as
// non-clickable text + url to avoid navigating the chrome window.
function renderMarkdown(src: string): string {
  const inline = (t: string) =>
    t
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 (<span class="md-url">$2</span>)');
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let inCode = false;
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      if (inCode) { html += '</code></pre>'; inCode = false; } else { closeList(); html += '<pre><code>'; inCode = true; }
      continue;
    }
    if (inCode) { html += escapeHtml(raw) + '\n'; continue; }
    const line = escapeHtml(raw);
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const lvl = h[1].length; html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; continue; }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  if (inCode) html += '</code></pre>';
  closeList();
  return html;
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
