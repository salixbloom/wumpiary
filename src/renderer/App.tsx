import React, { useEffect, useRef, useState } from 'react';
import { api, useStore } from './store';
import { Sidebar } from './Sidebar';
import { LockScreen } from './LockScreen';
import { Settings, SettingsTab } from './Settings';

export function App() {
  const state = useStore((s) => s.state);
  const [tab, setTab] = useState<SettingsTab | null>(null);
  const [settingsAccount, setSettingsAccount] = useState<string | null>(null);
  const [autofillId, setAutofillId] = useState<string | null>(null);
  const [themeWipe, setThemeWipe] = useState<{ id: number; color: string } | null>(null);
  const lastShellVars = useRef<ShellVars | null>(null);
  const wipeTimer = useRef<number | null>(null);

  // Main asks us to open the autofill PIN prompt when a signed-out account that
  // has a saved login is activated (e.g. via the "signed out" notification).
  useEffect(() => api.onPromptAutofill(({ accountId }) => setAutofillId(accountId)), []);

  useEffect(() => {
    if (!state) return;
    const t = state.config.ui.theme;
    const resolved = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.setProperty('--accent', state.config.ui.accent);
  }, [state?.config.ui.theme, state?.config.ui.accent]);

  useEffect(() => {
    const root = document.documentElement;
    const next = resolveShellVars(state?.shellTheme);
    const prev = lastShellVars.current;
    const commit = () => {
      applyShellVars(root, next);
      lastShellVars.current = next;
      setThemeWipe(null);
    };

    if (wipeTimer.current) window.clearTimeout(wipeTimer.current);
    if (!prev || prev.appFrameBackground === next.appFrameBackground) {
      commit();
      return;
    }

    setThemeWipe({ id: Date.now(), color: next.appFrameBackground });
    wipeTimer.current = window.setTimeout(commit, THEME_WIPE_MS);
    return () => {
      if (wipeTimer.current) window.clearTimeout(wipeTimer.current);
    };
  }, [state?.shellTheme]);

  // Hide the native account views whenever a full-window modal is open.
  useEffect(() => {
    api.setOverlay(tab !== null);
  }, [tab]);

  if (!state) return <AppFrame themeWipe={themeWipe}><div className="loading">Loading...</div></AppFrame>;
  if (state.locked) return <AppFrame themeWipe={themeWipe}><LockScreen hasVault={state.hasVault} encryptionAvailable={state.encryptionAvailable} /></AppFrame>;

  const side = state.config.ui.sidebarSide;
  const sidebar = (
    <Sidebar
      state={state}
      onOpenSettings={() => setTab('general')}
      onAccountSettings={(id) => { setSettingsAccount(id); setTab('account'); }}
      onAutofill={(id) => setAutofillId(id)}
    />
  );

  return (
    <AppFrame themeWipe={themeWipe}>
      <div className={`app side-${side}`}>
        {side === 'left' && sidebar}
        <div className="stage">{!state.activeId && <EmptyState hasAccounts={state.config.accountsOrder.length > 0} />}</div>
        {side === 'right' && sidebar}
        {tab && (
          <Settings
            state={state}
            tab={tab}
            accountId={settingsAccount}
            onTab={setTab}
            onSelectAccount={setSettingsAccount}
            onClose={() => setTab(null)}
          />
        )}
        {autofillId && state.config.accounts[autofillId] && (
          <AutofillModal
            nickname={state.config.accounts[autofillId].nickname}
            accountId={autofillId}
            onClose={() => setAutofillId(null)}
          />
        )}
      </div>
    </AppFrame>
  );
}

type ShellVars = {
  appFrameBackground: string;
  bg: string;
  bg2: string;
  bg3: string;
  bgHover: string;
  text: string;
  textDim: string;
  border: string;
};

const SHELL_FALLBACK: ShellVars = {
  appFrameBackground: '#1e1f22',
  bg: '#1e1f22',
  bg2: '#2b2d31',
  bg3: '#313338',
  bgHover: '#35373c',
  text: '#dbdee1',
  textDim: '#949ba4',
  border: '#1f2023',
};
const THEME_WIPE_MS = 900;

function resolveShellVars(theme: {
  appFrameBackground?: string;
  bg?: string;
  bg2?: string;
  bg3?: string;
  bgHover?: string;
  text?: string;
  textDim?: string;
  border?: string;
} | null | undefined): ShellVars {
  const read = (value: string | undefined, fallbackValue: string) => value?.trim() || fallbackValue;
  return {
    appFrameBackground: read(theme?.appFrameBackground, SHELL_FALLBACK.appFrameBackground),
    bg: read(theme?.bg, SHELL_FALLBACK.bg),
    bg2: read(theme?.bg2, SHELL_FALLBACK.bg2),
    bg3: read(theme?.bg3, SHELL_FALLBACK.bg3),
    bgHover: read(theme?.bgHover, SHELL_FALLBACK.bgHover),
    text: read(theme?.text, SHELL_FALLBACK.text),
    textDim: read(theme?.textDim, SHELL_FALLBACK.textDim),
    border: read(theme?.border, SHELL_FALLBACK.border),
  };
}

function applyShellVars(root: HTMLElement, vars: ShellVars) {
  root.style.setProperty('--app-frame-background', vars.appFrameBackground);
  root.style.setProperty('--shell-bg', vars.bg);
  root.style.setProperty('--shell-bg-2', vars.bg2);
  root.style.setProperty('--shell-bg-3', vars.bg3);
  root.style.setProperty('--shell-bg-hover', vars.bgHover);
  root.style.setProperty('--shell-text', vars.text);
  root.style.setProperty('--shell-text-dim', vars.textDim);
  root.style.setProperty('--shell-border', vars.border);
}

function AppFrame({ children, themeWipe }: { children: React.ReactNode; themeWipe: { id: number; color: string } | null }) {
  return (
    <div className="app-frame">
      {themeWipe && <div key={themeWipe.id} className="theme-wipe" style={{ '--wipe-color': themeWipe.color } as React.CSSProperties} />}
      <div className="titlebar">
        <div className="titlebar-brand">wumpiary</div>
        <div className="window-controls">
          <button title="Minimize" aria-label="Minimize" onClick={() => api.minimizeWindow()}><MinusIcon /></button>
          <button title="Maximize or restore" aria-label="Maximize or restore" onClick={() => api.toggleMaximizeWindow()}><WindowIcon /></button>
          <button className="close" title="Close" aria-label="Close" onClick={() => api.closeWindow()}><CloseIcon /></button>
        </div>
      </div>
      <div className="app-body">{children}</div>
    </div>
  );
}

function MinusIcon() {
  return (
    <svg className="window-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8h10" />
    </svg>
  );
}

function WindowIcon() {
  return (
    <svg className="window-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="window-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function AutofillModal({ nickname, accountId, onClose }: { nickname: string; accountId: string; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin || busy) return;
    setBusy(true);
    setError(null);
    const r = await api.autofillLogin(accountId, pin);
    setBusy(false);
    setPin('');
    if (r.ok) onClose();
    else setError(r.error === 'wrong-pin' ? 'Incorrect PIN.' : 'No saved password for this account.');
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="pin-modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Sign in to {nickname}</h3>
        <p className="note">Enter your PIN to autofill the login. You will still solve any captcha / 2FA and click Log In yourself.</p>
        <input type="password" autoFocus inputMode="numeric" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
        {error && <p className="pin-error">{error}</p>}
        <div className="pin-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!pin || busy}>{busy ? 'Filling...' : 'Autofill'}</button>
        </div>
      </form>
    </div>
  );
}

function EmptyState({ hasAccounts }: { hasAccounts: boolean }) {
  return (
    <div className="empty">
      <div className="empty-logo" />
      <h1>wumpiary</h1>
      {hasAccounts ? (
        <p>No account selected - pick one from the sidebar, or wake a hibernated account.</p>
      ) : (
        <>
          <p>Run all your Discord accounts at once, each connected and notifying in the background.</p>
          <button className="primary" onClick={() => api.addAccount()}>Add your first account</button>
        </>
      )}
    </div>
  );
}
