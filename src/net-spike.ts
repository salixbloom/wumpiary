import { app, BaseWindow, WebContentsView, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { startWsServer, WsHub } from './ws-server';

// ---------------------------------------------------------------------------
// Phase-0 follow-up spike: WebSocket throttling exemption (E), reconnection
// resilience (G), and real Discord client footprint (F via DISCORD=1).
// ---------------------------------------------------------------------------

const N = 3;
const THROTTLE = process.env.BG_THROTTLE === '1';
const DISCORD = process.env.DISCORD === '1';
const HOLD_MS = Number(process.env.HOLD_MS ?? 180000);
const PORT = 8799;

app.commandLine.appendSwitch('no-sandbox');

const HEAVY_WS = path.join(__dirname, '..', 'src', 'heavy-ws.html');
const PRELOAD_WS = path.join(__dirname, 'preload-ws.js');

const beats = new Map<string, { lastN: number; maxDrift: number; count: number }>();
const wsState = new Map<string, string>();
const wsLog: { t: number; id: string; state: string }[] = [];
let t0 = Date.now();

ipcMain.on('hb', (_e, { id, n, drift }: { id: string; n: number; drift: number }) => {
  const b = beats.get(id) ?? { lastN: 0, maxDrift: 0, count: 0 };
  b.lastN = n; b.maxDrift = Math.max(b.maxDrift, drift); b.count += 1;
  beats.set(id, b);
});
ipcMain.on('ws-state', (_e, { id, state }: { id: string; state: string }) => {
  if (wsState.get(id) !== state) { wsState.set(id, state); wsLog.push({ t: Math.round((Date.now() - t0) / 1000), id, state }); }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rendererRssMB = () => +(app.getAppMetrics().filter((m) => m.type === 'Tab').reduce((a, m) => a + (m.memory?.workingSetSize ?? 0), 0) / 1024).toFixed(0);
const totalCpu = () => +app.getAppMetrics().reduce((a, m) => a + (m.cpu?.percentCPUUsage ?? 0), 0).toFixed(1);

async function makeView(win: BaseWindow, id: string, url: string, isFile: boolean, query?: Record<string, string>) {
  const view = new WebContentsView({
    webPreferences: {
      preload: DISCORD ? undefined : PRELOAD_WS,
      backgroundThrottling: THROTTLE,
      contextIsolation: true,
      sandbox: false,
      additionalArguments: [`--acct=${id}`],
    },
  });
  view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
  win.contentView.addChildView(view);
  if (isFile) await view.webContents.loadFile(url, { query });
  else await view.webContents.loadURL(url);
  return view;
}

async function runDiscordFootprint() {
  const win = new BaseWindow({ width: 1200, height: 800, show: false });
  console.log(`\n=== real Discord footprint — ${N} isolated views of discord.com/app ===\n`);
  const before = rendererRssMB();
  const views: WebContentsView[] = [];
  for (let i = 0; i < N; i++) {
    const v = await makeView(win, `acct-${i}`, 'https://discord.com/app', false);
    views.push(v);
    console.log(`loaded view ${i}: title="${v.webContents.getTitle()}"`);
  }
  console.log('settling 20s for SPA/network to finish...');
  await sleep(20000);
  const after = rendererRssMB();
  const procs = app.getAppMetrics().filter((m) => m.type === 'Tab').length;
  const perView = +((after - before) / N).toFixed(0);
  console.log(`\nrenderer RAM: ${before}MB -> ${after}MB  (~${perView}MB/account, unauthenticated login screen)`);
  console.log(`renderer processes: ${procs}, CPU now ${totalCpu()}%`);
  fs.writeFileSync(path.join(__dirname, '..', 'report-discord-footprint.json'), JSON.stringify({ before, after, perViewMB: perView, procs, note: 'unauthenticated; logged-in client will be heavier' }, null, 2));
  app.quit();
}

async function runWsExperiments() {
  const hub: WsHub = await startWsServer(PORT);
  const win = new BaseWindow({ width: 1200, height: 800, show: false });
  console.log(`\n=== net spike — WS exemption + reconnection (throttling:${THROTTLE}, ${N} views) ===\n`);

  // server pushes keepalive frames (gateway-like incoming traffic)
  const pusher = setInterval(() => hub.broadcast(JSON.stringify({ op: 'tick', t: Date.now() })), 3000);

  const views: WebContentsView[] = [];
  for (let i = 0; i < N; i++) views.push(await makeView(win, `acct-${i}`, HEAVY_WS, true, { port: String(PORT) }));
  await sleep(3000);
  console.log(`connected clients: ${hub.clients()}`);

  // --- E: throttling exemption. Hide all views, hold, measure heartbeat drift.
  t0 = Date.now();
  for (const b of beats.values()) { b.maxDrift = 0; b.count = 0; }
  for (const v of views) v.setVisible(false);
  console.log(`\n[E] all ${N} views hidden + active WS; holding ${HOLD_MS / 1000}s (throttling:${THROTTLE})...`);
  const holdT0 = Date.now();
  while (Date.now() - holdT0 < HOLD_MS) {
    await sleep(30000);
    const arr = [...beats.values()];
    console.log(`  t=${Math.round((Date.now() - holdT0) / 1000)}s  beats(min)=${Math.min(...arr.map((b) => b.count))}  maxDrift=${Math.max(...arr.map((b) => b.maxDrift))}ms  clients=${hub.clients()}`);
  }
  const eMaxDrift = Math.max(...[...beats.values()].map((b) => b.maxDrift));
  const eVerdict = eMaxDrift < 5000 ? 'HEARTBEAT SURVIVES (WS exemption holds)' : 'HEARTBEAT STALLED (no exemption)';
  console.log(`[E] verdict: ${eVerdict}  maxDrift=${eMaxDrift}ms`);

  // --- G: reconnection. Views stay hidden. Outage: close server, restart later.
  console.log(`\n[G] reconnection test (views remain hidden)...`);
  wsLog.length = 0; t0 = Date.now();
  console.log('  -> simulating gateway OUTAGE: closing server');
  await hub.close();
  clearInterval(pusher);
  await sleep(10000); // outage window
  console.log(`  -> after 10s outage, states: ${JSON.stringify(Object.fromEntries(wsState))}`);
  console.log('  -> restoring server');
  const hub2 = await startWsServer(PORT);
  const pusher2 = setInterval(() => hub2.broadcast(JSON.stringify({ op: 'tick', t: Date.now() })), 3000);
  await sleep(12000); // recovery window (backoff up to 8s)
  console.log(`  -> after restore, states: ${JSON.stringify(Object.fromEntries(wsState))}  reconnected clients: ${hub2.clients()}`);
  console.log(`  -> state timeline (t in s): ${JSON.stringify(wsLog)}`);
  const recovered = [...wsState.values()].every((s) => s === 'connected') && hub2.clients() === N;

  clearInterval(pusher2);
  await hub2.close();

  fs.writeFileSync(path.join(__dirname, '..', `report-net-throttle-${THROTTLE}.json`), JSON.stringify({
    config: { views: N, backgroundThrottling: THROTTLE, holdSec: HOLD_MS / 1000 },
    E_exemption: { maxDriftMs: eMaxDrift, verdict: eVerdict },
    G_reconnect: { recovered, reconnectedClients: hub2.clients(), timeline: wsLog },
  }, null, 2));
  console.log(`\n[G] verdict: ${recovered ? 'ALL ACCOUNTS RECONNECTED' : 'RECONNECT INCOMPLETE'}\n`);
  app.quit();
}

app.whenReady().then(DISCORD ? runDiscordFootprint : runWsExperiments).catch((e) => { console.error(e); app.exit(1); });
