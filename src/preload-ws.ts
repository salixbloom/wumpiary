import { ipcRenderer } from 'electron';

// Observe-only: heartbeat-drift timer (same event loop as a gateway heartbeat)
// plus relaying the page's WebSocket connection state to the main process.

const id = process.argv.find((a) => a.startsWith('--acct='))?.slice('--acct='.length) ?? '?';
const INTERVAL = 1000;
let n = 0;
const start = Date.now();

setInterval(() => {
  n += 1;
  const drift = Date.now() - (start + n * INTERVAL);
  ipcRenderer.send('hb', { id, n, drift });
}, INTERVAL);

window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as { __ws?: boolean; state?: string };
  if (d && d.__ws) ipcRenderer.send('ws-state', { id, state: d.state });
});
