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

  // Hide the native account views whenever a full-window modal is open.
  useEffect(() => {
    api.setOverlay(tab !== null);
  }, [tab]);

  if (!state) return <div className="loading">Loading…</div>;
  if (state.locked) return <LockScreen hasVault={state.hasVault} encryptionAvailable={state.encryptionAvailable} />;

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
        <p className="note">Enter your PIN to autofill the login. You’ll still solve any captcha / 2FA and click Log In yourself.</p>
        <input type="password" autoFocus inputMode="numeric" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
        {error && <p className="pin-error">{error}</p>}
        <div className="pin-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!pin || busy}>{busy ? 'Filling…' : 'Autofill'}</button>
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
        <p>No account selected — pick one from the sidebar, or wake a hibernated account.</p>
      ) : (
        <>
          <p>Run all your Discord accounts at once, each connected and notifying in the background.</p>
          <button className="primary" onClick={() => api.addAccount()}>Add your first account</button>
        </>
      )}
    </div>
  );
}
