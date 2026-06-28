import React, { useState } from 'react';
import { api } from './store';
import { createT, LOCALES, LOCALE_IDS, DEFAULT_LOCALE } from '../shared/i18n';

export function LockScreen({
  hasVault,
  encryptionAvailable,
  locale,
}: {
  hasVault: boolean;
  encryptionAvailable: boolean;
  locale: string;
}) {
  const t = createT(locale);
  const setup = !hasVault;
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (setup) {
      if (pin.length < 4) return setErr(t('lock.error.tooShort'));
      if (pin !== pin2) return setErr(t('lock.error.mismatch'));
      await api.setupPin(pin);
    } else {
      const r = await api.unlock(pin);
      if (!r.ok) {
        setErr(r.waitMs ? t('lock.error.tooMany', { secs: Math.ceil(r.waitMs / 1000) }) : t('lock.error.wrong'));
        setPin('');
      }
    }
  };

  return (
    <div className="lock">
      <form className="lock-card" onSubmit={submit}>
        <div className="empty-logo" />
        <h1>{t('lock.brand')}</h1>
        {setup ? (
          <>
            <p>{t('lock.setup.hint')}</p>
            <input type="password" autoFocus placeholder={t('lock.setup.newPin')} value={pin} onChange={(e) => setPin(e.target.value)} />
            <input type="password" placeholder={t('lock.setup.confirmPin')} value={pin2} onChange={(e) => setPin2(e.target.value)} />
            {!encryptionAvailable && <p className="warn">{t('lock.setup.keystoreWarning')}</p>}
            <button className="primary" type="submit">{t('lock.setup.submit')}</button>
          </>
        ) : (
          <>
            <p>{t('lock.unlock.hint')}</p>
            <input type="password" autoFocus placeholder={t('lock.unlock.pin')} value={pin} onChange={(e) => setPin(e.target.value)} />
            <button className="primary" type="submit">{t('lock.unlock.submit')}</button>
          </>
        )}
        {err && <p className="error">{err}</p>}
        <div className="lock-language">
          <label htmlFor="lock-locale-select">{t('lock.language')}</label>
          <select
            id="lock-locale-select"
            value={locale ?? DEFAULT_LOCALE}
            onChange={(e) => api.setLocale(e.target.value)}
          >
            {LOCALE_IDS.map((id) => (
              <option key={id} value={id}>{LOCALES[id]}</option>
            ))}
          </select>
        </div>
      </form>
    </div>
  );
}
