import { useEffect, useState } from 'react';
import { api, useStore } from './store';
import { Sidebar } from './Sidebar';
import { LockScreen } from './LockScreen';
import { Settings, SettingsTab } from './Settings';

export function App() {
  const state = useStore((s) => s.state);
  const [tab, setTab] = useState<SettingsTab | null>(null);
  const [settingsAccount, setSettingsAccount] = useState<string | null>(null);

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
