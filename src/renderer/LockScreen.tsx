import React, { useState } from 'react';
import { api } from './store';

export function LockScreen({ hasVault, encryptionAvailable }: { hasVault: boolean; encryptionAvailable: boolean }) {
  const setup = !hasVault;
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (setup) {
      if (pin.length < 4) return setErr('PIN must be at least 4 characters.');
      if (pin !== pin2) return setErr('PINs do not match.');
      await api.setupPin(pin);
    } else {
      const r = await api.unlock(pin);
      if (!r.ok) {
        setErr(r.waitMs ? `Too many attempts — wait ${Math.ceil(r.waitMs / 1000)}s.` : 'Wrong PIN.');
        setPin('');
      }
    }
  };

  return (
    <div className="lock">
      <form className="lock-card" onSubmit={submit}>
        <div className="empty-logo" />
        <h1>wumpiary</h1>
        {setup ? (
          <>
            <p>Welcome. Set a PIN to protect your accounts — you'll enter it to unlock the app.</p>
            <input type="password" autoFocus placeholder="New PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
            <input type="password" placeholder="Confirm PIN" value={pin2} onChange={(e) => setPin2(e.target.value)} />
            {!encryptionAvailable && <p className="warn">OS keychain unavailable here — the vault is protected by your PIN alone.</p>}
            <button className="primary" type="submit">Set PIN &amp; continue</button>
          </>
        ) : (
          <>
            <p>Enter your PIN to unlock and restore all sessions.</p>
            <input type="password" autoFocus placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
            <button className="primary" type="submit">Unlock</button>
          </>
        )}
        {err && <p className="error">{err}</p>}
      </form>
    </div>
  );
}
