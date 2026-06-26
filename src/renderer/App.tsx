import React, { useEffect, useState } from 'react';
import { api, useStore } from './store';
import { Sidebar } from './Sidebar';
import { LockScreen } from './LockScreen';
import { Settings, SettingsTab } from './Settings';

export function App() {
  const state = useStore((s) => s.state);
  const [tab, setTab] = useState<SettingsTab | null>(null);
  const [settingsAccount, setSettingsAccount] = useState<string | null>(null);
  const [autofillId, setAutofillId] = useState<string | null>(null);

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
    const fallback = {
      appFrameBackground: '#1e1f22',
      bg: '#1e1f22',
      bg2: '#2b2d31',
      bg3: '#313338',
      bgHover: '#35373c',
      text: '#dbdee1',
      textDim: '#949ba4',
      border: '#1f2023',
    };
    const theme = state?.shellTheme;
    const read = (value: string | undefined, fallbackValue: string) => value?.trim() || fallbackValue;
    root.style.setProperty('--app-frame-background', read(theme?.appFrameBackground, fallback.appFrameBackground));
    root.style.setProperty('--shell-bg', read(theme?.bg, fallback.bg));
    root.style.setProperty('--shell-bg-2', read(theme?.bg2, fallback.bg2));
    root.style.setProperty('--shell-bg-3', read(theme?.bg3, fallback.bg3));
    root.style.setProperty('--shell-bg-hover', read(theme?.bgHover, fallback.bgHover));
    root.style.setProperty('--shell-text', read(theme?.text, fallback.text));
    root.style.setProperty('--shell-text-dim', read(theme?.textDim, fallback.textDim));
    root.style.setProperty('--shell-border', read(theme?.border, fallback.border));
  }, [state?.shellTheme]);

  // Hide the native account views whenever a full-window modal is open.
  useEffect(() => {
    api.setOverlay(tab !== null);
  }, [tab]);

  if (!state) return <AppFrame><div className="loading">Loading...</div></AppFrame>;
  if (state.locked) return <AppFrame><LockScreen hasVault={state.hasVault} encryptionAvailable={state.encryptionAvailable} /></AppFrame>;

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
    <AppFrame>
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

function AppFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-frame">
      <div className="titlebar">
        <div className="titlebar-brand">wumpiary</div>
        <div className="window-controls">
          <button title="Minimize" onClick={() => api.minimizeWindow()}>_</button>
          <button title="Maximize or restore" onClick={() => api.toggleMaximizeWindow()}>[]</button>
          <button className="close" title="Close" onClick={() => api.closeWindow()}>x</button>
        </div>
      </div>
      <div className="app-body">{children}</div>
    </div>
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
