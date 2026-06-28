import React from 'react';
import { api } from './store';
import { useT } from './i18n';
import { LOCALES, LOCALE_IDS } from '../shared/i18n';
import type { AppState, NotificationFilter, CallPolicy, Theme, GlobalConfig, AccountConfig } from '../shared/types';
import { HIGH_TRUST_PERMISSIONS } from '../shared/plugins';
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
  const t = useT();
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="modal-nav">
          <div className="modal-title">{t('settings.title')}</div>
          {(['general', 'account', 'activity', 'plugins', 'about'] as SettingsTab[]).map((tabId) => (
            <button key={tabId} className={tab === tabId ? 'active' : ''} onClick={() => onTab(tabId)}>
              {t(`settings.tab.${tabId}`)}
            </button>
          ))}
          <button className="modal-close" onClick={onClose}>{t('settings.close')}</button>
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
  const t = useT();
  const { ui, global } = state.config;
  return (
    <section>
      <h3>{t('settings.general.appearance')}</h3>
      <Row label={t('settings.general.theme')}>
        <select value={ui.theme} onChange={(e) => api.patchUi({ theme: e.target.value as Theme })}>
          <option value="dark">{t('settings.general.theme.dark')}</option>
          <option value="light">{t('settings.general.theme.light')}</option>
          <option value="system">{t('settings.general.theme.system')}</option>
        </select>
      </Row>
      <Row label={t('settings.general.accentColor')}>
        <input type="color" value={ui.accent} onChange={(e) => api.patchUi({ accent: e.target.value })} />
      </Row>
      <Row label={t('settings.general.sidebarSide')}>
        <select value={ui.sidebarSide} onChange={(e) => api.patchUi({ sidebarSide: e.target.value as 'left' | 'right' })}>
          <option value="right">{t('settings.general.sidebarSide.right')}</option>
          <option value="left">{t('settings.general.sidebarSide.left')}</option>
        </select>
      </Row>
      <Row label={t('settings.general.sidebarWidth')} hint={t('settings.general.sidebarWidth.hint')}>
        <input type="range" min={180} max={360} value={ui.sidebarWidth} onChange={(e) => api.patchUi({ sidebarWidth: +e.target.value })} />
      </Row>

      <h3>{t('settings.general.notifications')}</h3>
      <Row label={t('settings.general.dnd')} hint={t('settings.general.dnd.hint')}>
        <Toggle on={global.dnd} onChange={(v) => api.patchGlobal({ dnd: v })} />
      </Row>
      <Row label={t('settings.general.hidePreviews')} hint={t('settings.general.hidePreviews.hint')}>
        <Toggle on={global.hidePreviews} onChange={(v) => api.patchGlobal({ hidePreviews: v })} />
      </Row>

      <h3>{t('settings.general.voice')}</h3>
      <Row label={t('settings.general.ptt')} hint={t('settings.general.ptt.hint')}>
        <Toggle on={global.pushToTalk.enabled} onChange={(v) => api.patchGlobal({ pushToTalk: { enabled: v } })} />
      </Row>
      <Row label={t('settings.general.pttKey')}>
        <HotkeyCapture value={global.pushToTalk} onChange={(pushToTalk) => api.patchGlobal({ pushToTalk })} />
      </Row>
      <Row label={t('settings.general.activateSound')} hint={t('settings.general.activateSound.hint')}>
        <input
          placeholder="default"
          value={global.pushToTalk.activateSound === 'default' ? '' : global.pushToTalk.activateSound}
          onChange={(e) => api.patchGlobal({ pushToTalk: { activateSound: e.target.value || 'default' } })}
        />
      </Row>
      <Row label={t('settings.general.deactivateSound')} hint={t('settings.general.deactivateSound.hint')}>
        <input
          placeholder="default"
          value={global.pushToTalk.deactivateSound === 'default' ? '' : global.pushToTalk.deactivateSound}
          onChange={(e) => api.patchGlobal({ pushToTalk: { deactivateSound: e.target.value || 'default' } })}
        />
      </Row>
      {global.pushToTalk.enabled && (
        <p className="note">{pushToTalkStatusText(state, t)}</p>
      )}

      <h3>{t('settings.general.startup')}</h3>
      <Row label={t('settings.general.autoLaunch')}>
        <Toggle on={global.autoLaunch} onChange={(v) => api.patchGlobal({ autoLaunch: v })} />
      </Row>
      <Row label={t('settings.general.startMinimized')}>
        <Toggle on={global.startMinimized} onChange={(v) => api.patchGlobal({ startMinimized: v })} />
      </Row>
      <Row label={t('settings.general.autoLock')}>
        <select value={global.autoLockMinutes} onChange={(e) => api.patchGlobal({ autoLockMinutes: +e.target.value })}>
          <option value={0}>{t('settings.general.autoLock.off')}</option>
          <option value={5}>{t('settings.general.autoLock.5min')}</option>
          <option value={15}>{t('settings.general.autoLock.15min')}</option>
          <option value={30}>{t('settings.general.autoLock.30min')}</option>
          <option value={60}>{t('settings.general.autoLock.1hour')}</option>
        </select>
      </Row>

      <h3>{t('settings.general.resources')}</h3>
      <Row label={t('settings.general.autoHibernate')} hint={t('settings.general.autoHibernate.hint')}>
        <select value={global.autoHibernateMinutes} onChange={(e) => api.patchGlobal({ autoHibernateMinutes: +e.target.value })}>
          <option value={0}>{t('settings.general.autoHibernate.off')}</option>
          <option value={30}>{t('settings.general.autoHibernate.30min')}</option>
          <option value={60}>{t('settings.general.autoHibernate.1hour')}</option>
          <option value={180}>{t('settings.general.autoHibernate.3hours')}</option>
        </select>
      </Row>
      <p className="note">{t('settings.general.resourcesNote')}</p>

      <h3>{t('settings.general.language')}</h3>
      <Row label={t('settings.general.language')}>
        <select value={ui.locale} onChange={(e) => api.setLocale(e.target.value)}>
          {LOCALE_IDS.map((id) => (
            <option key={id} value={id}>{LOCALES[id]}</option>
          ))}
        </select>
      </Row>
    </section>
  );
}

function pushToTalkStatusText(state: AppState, t: (key: string, vars?: Record<string, string | number>) => string) {
  const status = state.pushToTalkStatus;
  if (status.active) return t('settings.general.pttStatus.active');
  if (status.error) return t('settings.general.pttStatus.error', { error: status.error });
  return t('settings.general.pttStatus.fallback');
}

function HotkeyCapture({
  value,
  onChange,
}: {
  value: GlobalConfig['pushToTalk'];
  onChange: (value: Partial<GlobalConfig['pushToTalk']>) => void;
}) {
  const t = useT();
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
      {recording ? t('hotkey.recording') : formatHotkey(value)}
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
  const t = useT();
  const id = accountId && state.config.accounts[accountId] ? accountId : state.config.accountsOrder[0];
  const acc = id ? state.config.accounts[id] : null;
  if (!acc) return <p className="note">{t('settings.account.noAccounts')}</p>;
  const n = acc.notifications;
  return (
    <section>
      <Row label={t('settings.account.account')}>
        <select value={id} onChange={(e) => onSelectAccount(e.target.value)}>
          {state.config.accountsOrder.map((aid) => (
            <option key={aid} value={aid}>{state.config.accounts[aid].nickname}</option>
          ))}
        </select>
      </Row>

      <h3>{t('settings.account.identity')}</h3>
      <Row label={t('settings.account.nickname')}>
        <input value={acc.nickname} onChange={(e) => api.updateAccount(id, { nickname: e.target.value })} />
      </Row>
      <Row label={t('settings.account.colorTag')}>
        <input type="color" value={acc.color} onChange={(e) => api.updateAccount(id, { color: e.target.value })} />
      </Row>
      <Row label={t('settings.account.avatar')} hint={t('settings.account.avatar.hint')}>
        <input placeholder="/path/to/image.png" value={acc.avatarOverride ?? ''} onChange={(e) => api.updateAccount(id, { avatarOverride: e.target.value || null })} />
      </Row>

      <h3>{t('settings.account.notifications')}</h3>
      <Row label={t('settings.account.mute')}>
        <Toggle on={n.muted} onChange={(v) => api.updateAccount(id, { notifications: { muted: v } })} />
      </Row>
      <Row label={t('settings.account.filter')}>
        <select value={n.filter} onChange={(e) => api.updateAccount(id, { notifications: { filter: e.target.value as NotificationFilter } })}>
          <option value="all">{t('settings.account.filter.all')}</option>
          <option value="mentions+dms">{t('settings.account.filter.mentionsDms')}</option>
          <option value="mentions">{t('settings.account.filter.mentions')}</option>
          <option value="dms">{t('settings.account.filter.dms')}</option>
          <option value="none">{t('settings.account.filter.none')}</option>
        </select>
      </Row>
      <Row label={t('settings.account.hidePreviews')}>
        <Toggle on={n.hidePreview} onChange={(v) => api.updateAccount(id, { notifications: { hidePreview: v } })} />
      </Row>
      <Row label={t('settings.account.chime')} hint={t('settings.account.chime.hint')}>
        <input placeholder="default" value={n.chime === 'default' ? '' : n.chime} onChange={(e) => api.updateAccount(id, { notifications: { chime: e.target.value || 'default' } })} />
      </Row>

      <h3>{t('settings.account.calls')}</h3>
      <Row label={t('settings.account.callPolicy')}>
        <select value={acc.calls.policy} onChange={(e) => api.updateAccount(id, { calls: { policy: e.target.value as CallPolicy } })}>
          <option value="allow">{t('settings.account.callPolicy.allow')}</option>
          <option value="muted">{t('settings.account.callPolicy.muted')}</option>
          <option value="silent">{t('settings.account.callPolicy.silent')}</option>
          <option value="block">{t('settings.account.callPolicy.block')}</option>
        </select>
      </Row>

      <h3>{t('settings.account.privacy')}</h3>
      <Row label={t('settings.account.proxy')} hint={t('settings.account.proxy.hint')}>
        <input placeholder="none" value={acc.proxy ?? ''} onChange={(e) => api.updateAccount(id, { proxy: e.target.value || null })} />
      </Row>

      <h3>{t('settings.account.savedLogin')}</h3>
      <SavedLogin accountId={id} saved={state.savedLogins?.[id]} />
    </section>
  );
}

function SavedLogin({ accountId, saved }: { accountId: string; saved?: { email: boolean; password: boolean } }) {
  const t = useT();
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
    setMsg(r.ok ? t('settings.account.savedMsg') : t('settings.account.wrongPin'));
  };
  const clear = async () => { await api.clearLogin(accountId); setMsg(t('settings.account.cleared')); };

  return (
    <>
      <p className="note">{t('settings.account.savedLogin.note')}</p>
      <p className="note">
        {t('settings.account.savedLogin.status', {
          email: saved?.email ? '✓' : '—',
          password: saved?.password ? '✓' : '—',
        })}
      </p>
      <Row label={t('settings.account.email')}>
        <input type="email" placeholder={saved?.email ? t('settings.account.email.saved') : t('settings.account.email.placeholder')} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
      </Row>
      <Row label={t('settings.account.password')} hint={t('settings.account.password.hint')}>
        <input type="password" placeholder={saved?.password ? t('settings.account.password.saved') : t('settings.account.password.placeholder')} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
      </Row>
      <Row label={t('settings.account.confirmPin')} hint={t('settings.account.confirmPin.hint')}>
        <input type="password" inputMode="numeric" placeholder={t('settings.account.pin')} value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="off" />
      </Row>
      <div className="login-actions">
        <button className="primary" onClick={save} disabled={!pin || (!email && !password) || busy}>{busy ? t('settings.account.saving') : t('settings.account.saveLogin')}</button>
        {(saved?.email || saved?.password) && <button className="danger" onClick={clear}>{t('settings.account.clearLogin')}</button>}
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
  const t = useT();
  return (
    <section>
      <div className="row">
        <h3>{t('settings.activity.inbox')}</h3>
        <button className="secondary" onClick={() => api.clearActivity()}>{t('settings.activity.clear')}</button>
      </div>
      {state.activity.length === 0 && <p className="note">{t('settings.activity.empty')}</p>}
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
  const t = useT();
  const plugins = state.plugins ?? [];
  const [sub, setSub] = React.useState<{ kind: 'config' | 'help'; id: string } | null>(null);
  const subPlugin = sub ? plugins.find((p) => p.id === sub.id) ?? null : null;

  if (sub && subPlugin) {
    if (sub.kind === 'config') return <PluginConfig p={subPlugin} onBack={() => setSub(null)} />;
    return <PluginHelp p={subPlugin} onBack={() => setSub(null)} />;
  }

  return (
    <section>
      <div className="row">
        <h3>{t('settings.plugins.title')}</h3>
        <span className="btn-row">
          <button className="secondary" onClick={() => api.openPluginsFolder()}>{t('settings.plugins.openFolder')}</button>
          <button className="secondary" onClick={() => api.reloadPlugins()}>{t('settings.plugins.reload')}</button>
        </span>
      </div>
      <p className="note">{t('settings.plugins.note')}</p>
      <Row label={t('settings.plugins.storageLimit')} hint={t('settings.plugins.storageLimit.hint')}>
        <input type="range" min={1} max={500} value={state.config.global.pluginStorageMb}
          onChange={(e) => api.patchGlobal({ pluginStorageMb: +e.target.value })} />
        <small className="slider-val">{t('settings.plugins.storageLimit.value', { mb: state.config.global.pluginStorageMb })}</small>
      </Row>
      {plugins.length === 0 && <p className="note">{t('settings.plugins.empty')}</p>}
      <ul className="plugins">
        {plugins.map((p) => (
          <PluginCard key={p.id} p={p} onConfig={() => setSub({ kind: 'config', id: p.id })} onHelp={() => setSub({ kind: 'help', id: p.id })} />
        ))}
      </ul>
    </section>
  );
}

function PluginCard({ p, onConfig, onHelp }: { p: PluginInfo; onConfig: () => void; onHelp: () => void }) {
  const t = useT();
  const m = p.metadata ?? {};
  const automationWarning = t('permission.automation.warning');
  return (
    <li className={`plugin ${p.error ? 'has-error' : ''}`}>
      <div className="plugin-head">
        <div className="plugin-id">
          <span className="plugin-name">{p.name}</span>
          <span className="plugin-version">v{p.version}</span>
          {p.author && <span className="plugin-author">{t('settings.plugins.by', { author: p.author })}</span>}
          {m.automationWarning && (
            <span className="plugin-badge warn" title={automationWarning} aria-label={automationWarning}>{t('settings.plugins.automation')}</span>
          )}
          {m.experimental && <span className="plugin-badge exp" title="May be unstable or change between versions.">{t('settings.plugins.experimental')}</span>}
          {(m.tags ?? []).map((tag) => (
            <span key={tag} className="plugin-badge tag">{tag}</span>
          ))}
        </div>
        <div className="plugin-actions">
          {p.ui.hasReadme && <button className="icon-btn" title={t('settings.plugins.helpTitle')} aria-label={t('settings.plugins.helpLabel')} onClick={onHelp}>?</button>}
          {p.enabled && p.ui.hasPanel && <button className="icon-btn" title={t('settings.plugins.configureTitle', { name: p.name })} aria-label={t('settings.plugins.configureLabel')} onClick={onConfig}>⚙</button>}
          <Toggle on={p.enabled} onChange={(v) => api.setPluginEnabled(p.id, v)} />
        </div>
      </div>
      {p.description && <p className="plugin-desc">{p.description}</p>}
      {p.error && <p className="plugin-error">⚠ {p.error}</p>}
      {p.enabled && p.ui.hasWindow && (
        <div className="plugin-ui-row">
          <button className="secondary" onClick={() => api.openPluginWindow(p.id)}>{t('settings.plugins.openWindow', { title: p.ui.windowTitle ?? 'window' })}</button>
        </div>
      )}
      {p.permissions.length > 0 && (
        <div className="plugin-perms">
          <small>{t('settings.plugins.permissions')}</small>
          {p.permissions.map((perm) => (
            <div key={perm.name} className={`row perm-row ${HIGH_TRUST_PERMISSIONS.includes(perm.name) ? 'high-trust' : ''}`}>
              <div className="row-label">
                <span>{perm.name}{HIGH_TRUST_PERMISSIONS.includes(perm.name) && <span className="perm-flag" title={t('settings.plugins.highTrustTitle')}>{t('settings.plugins.highTrust')}</span>}</span>
                <small>{t(`permission.${perm.name}`)}</small>
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
  const t = useT();
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
        <button className="secondary" onClick={onBack}>{t('settings.plugins.back')}</button>
        <h3>{t('settings.plugins.configPageTitle', { name: p.name, panelTitle: p.ui.panelTitle ?? t('settings.plugins.panelFallback') })}</h3>
      </div>
      <div className="plugin-config-host" ref={host}>{t('settings.plugins.loading')}</div>
    </section>
  );
}

// Help subpage: renders the plugin's README.md (rendered by us as markdown — no
// plugin code runs here).
function PluginHelp({ p, onBack }: { p: PluginInfo; onBack: () => void }) {
  const t = useT();
  const [md, setMd] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    api.getPluginReadme(p.id).then((content) => { if (alive) setMd(content ?? ''); });
    return () => { alive = false; };
  }, [p.id]);
  return (
    <section className="plugin-subpage">
      <div className="plugin-subhead">
        <button className="secondary" onClick={onBack}>{t('settings.plugins.back')}</button>
        <h3>{t('settings.plugins.helpPageTitle', { name: p.name })}</h3>
      </div>
      {md === null && <p className="note">{t('settings.plugins.loading')}</p>}
      {md === '' && <p className="note">{t('settings.plugins.noReadme')}</p>}
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
  const t = useT();
  return (
    <section className="about">
      <h3>{t('settings.about.brand')}</h3>
      <p>{t('settings.about.p1')}</p>
      <p>{t('settings.about.p2')}</p>
      <h3>{t('settings.about.security')}</h3>
      <p>{t('settings.about.securityNote')}</p>
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
