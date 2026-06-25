import { ipcRenderer } from 'electron';

// Observe-only measurement bridge. The heartbeat interval here lives in the
// renderer's event loop — exactly where Discord's gateway heartbeat timer would
// live — so its timing drift is a faithful proxy for "would the gateway keep
// beating while this account is backgrounded / un-rendered?".

const id = process.argv.find((a) => a.startsWith('--acct='))?.slice('--acct='.length) ?? '?';
const INTERVAL = 1000;

let n = 0;
const start = Date.now();

setInterval(() => {
  n += 1;
  const expected = start + n * INTERVAL;
  const drift = Date.now() - expected; // ms late this tick fired
  ipcRenderer.send('hb', { id, n, drift });
}, INTERVAL);

// Allow the harness to request a manual GC (process launched with --expose-gc).
ipcRenderer.on('gc', () => {
  const g = (globalThis as unknown as { gc?: () => void }).gc;
  if (g) g();
  ipcRenderer.send('gc-done', { id });
});
