import { app, BaseWindow, WebContentsView, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Phase 0 resource/stability spike for wumpiary.
//
// Measures, for an account view that has been backgrounded:
//   1. STABILITY  — does the renderer timer loop (the gateway heartbeat) keep
//      firing? Toggle BG_THROTTLE=1 to set backgroundThrottling:true and watch
//      hidden-view heartbeats stall. Default uses false (what §3 mandates).
//   2. RESOURCES  — three levers, weakest to strongest:
//        B un-render  (setVisible false): stops painting, JS keeps running.
//        C throttle   (setBackgroundThrottling true at runtime): cuts bg CPU
//                      but is the thing that kills the heartbeat.
//        D hibernate  (destroy the WebContents): frees the renderer process /
//                      RAM entirely; account goes offline (opt-in only).
// ---------------------------------------------------------------------------

const N = 5;
const THROTTLE = process.env.BG_THROTTLE === '1';

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('js-flags', '--expose-gc');

const HEAVY = path.join(__dirname, '..', 'src', 'heavy.html');
const PRELOAD = path.join(__dirname, 'preload.js');

interface Beat { lastN: number; lastDrift: number; maxDriftThisPhase: number; beatsThisPhase: number; }
const beats = new Map<string, Beat>();

ipcMain.on('hb', (_e, { id, n, drift }: { id: string; n: number; drift: number }) => {
  const b = beats.get(id) ?? { lastN: 0, lastDrift: 0, maxDriftThisPhase: 0, beatsThisPhase: 0 };
  b.lastN = n; b.lastDrift = drift;
  b.maxDriftThisPhase = Math.max(b.maxDriftThisPhase, drift);
  b.beatsThisPhase += 1;
  beats.set(id, b);
});

interface Sample { phase: string; totalCpu: number; rendererMem: number; totalMem: number; procCount: number; }
const samples: Sample[] = [];
let currentPhase = 'init';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startPhase(name: string) {
  currentPhase = name;
  for (const b of beats.values()) { b.maxDriftThisPhase = 0; b.beatsThisPhase = 0; }
}

function sampleMetrics() {
  let totalCpu = 0, rendererMem = 0, totalMem = 0;
  const metrics = app.getAppMetrics();
  for (const m of metrics) {
    totalCpu += m.cpu?.percentCPUUsage ?? 0;
    totalMem += m.memory?.workingSetSize ?? 0;
    if (m.type === 'Tab') rendererMem += m.memory?.workingSetSize ?? 0;
  }
  samples.push({ phase: currentPhase, totalCpu, rendererMem, totalMem, procCount: metrics.length });
}

function phaseStats(phase: string) {
  const s = samples.filter((x) => x.phase === phase).slice(2); // drop 2 settling samples
  if (!s.length) return null;
  const avg = (f: (x: Sample) => number) => s.reduce((a, x) => a + f(x), 0) / s.length;
  return {
    avgCpuPct: +avg((x) => x.totalCpu).toFixed(1),
    rendererMemMB: +(avg((x) => x.rendererMem) / 1024).toFixed(0),
    totalMemMB: +(avg((x) => x.totalMem) / 1024).toFixed(0),
    procCount: Math.round(avg((x) => x.procCount)),
  };
}

// beats observed during a phase, snapshotted at its end
function beatSnapshot() {
  const out: Record<string, { beats: number; maxDrift: number }> = {};
  for (const [id, b] of beats) out[id] = { beats: b.beatsThisPhase, maxDrift: b.maxDriftThisPhase };
  return out;
}

function rendererRssKB() {
  return app.getAppMetrics().filter((m) => m.type === 'Tab').reduce((a, m) => a + (m.memory?.workingSetSize ?? 0), 0);
}

async function run() {
  const win = new BaseWindow({ width: 1200, height: 800, show: false });
  const bounds = { x: 0, y: 0, width: 1200, height: 800 };
  const views: (WebContentsView | null)[] = [];

  for (let i = 0; i < N; i++) {
    const id = `acct-${i}`;
    const view = new WebContentsView({
      webPreferences: {
        preload: PRELOAD,
        backgroundThrottling: THROTTLE,
        contextIsolation: true,
        sandbox: false,
        additionalArguments: [`--acct=${id}`],
      },
    });
    view.setBounds(bounds);
    win.contentView.addChildView(view);
    await view.webContents.loadFile(HEAVY);
    views.push(view);
  }

  console.log(`\n=== wumpiary phase-0 spike — backgroundThrottling:${THROTTLE} , views:${N} ===\n`);
  const sampler = setInterval(sampleMetrics, 1000);
  const phaseBeats: Record<string, ReturnType<typeof beatSnapshot>> = {};

  // -------------------------------------------------------------------------
  // LONG-HOLD mode (HOLD_MS): the decisive stability test. Hide the background
  // views and hold for several minutes — long enough to cross Chromium's ~5min
  // intensive-throttling threshold — tracking heartbeat drift the whole time.
  // -------------------------------------------------------------------------
  const HOLD_MS = Number(process.env.HOLD_MS ?? 0);
  if (HOLD_MS > 0) {
    startPhase('warmup');
    await sleep(4000);
    for (let i = 1; i < N; i++) views[i]!.setVisible(false);
    startPhase('hold');
    const t0 = Date.now();
    console.log(`holding ${N - 1} views hidden for ${Math.round(HOLD_MS / 1000)}s (throttling:${THROTTLE})...`);
    while (Date.now() - t0 < HOLD_MS) {
      await sleep(30000);
      const bg = [...beats].filter(([id]) => id !== 'acct-0');
      const minBeats = Math.min(...bg.map(([, b]) => b.beatsThisPhase));
      const maxD = Math.max(...bg.map(([, b]) => b.maxDriftThisPhase));
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`  t=${elapsed}s  bgBeats(min since phase start)=${minBeats}  maxDrift=${maxD}ms`);
    }
    clearInterval(sampler);
    const bg = [...beats].filter(([id]) => id !== 'acct-0');
    const report = {
      mode: 'long-hold',
      config: { views: N, backgroundThrottling: THROTTLE, holdSec: HOLD_MS / 1000, electron: process.versions.electron },
      bgHeartbeat: { totalBeats: bg.map(([, b]) => b.beatsThisPhase), maxDriftMs: Math.max(...bg.map(([, b]) => b.maxDriftThisPhase)) },
      verdict: Math.max(...bg.map(([, b]) => b.maxDriftThisPhase)) < 5000 ? 'HEARTBEAT SURVIVES' : 'HEARTBEAT STALLED',
    };
    console.log(`\nLONG-HOLD verdict (throttling:${THROTTLE}): ${report.verdict}  maxDrift=${report.bgHeartbeat.maxDriftMs}ms`);
    fs.writeFileSync(path.join(__dirname, '..', `report-hold-throttle-${THROTTLE}.json`), JSON.stringify(report, null, 2));
    app.quit();
    return;
  }

  // A — baseline: all views rendered & active.
  startPhase('A:all-active');
  await sleep(9000);
  phaseBeats['A'] = beatSnapshot();

  // B — un-render backgrounds (setVisible false). Painting stops; JS keeps going.
  startPhase('B:bg-unrendered');
  for (let i = 1; i < N; i++) views[i]!.setVisible(false);
  await sleep(9000);
  phaseBeats['B'] = beatSnapshot();

  // C — runtime throttle the backgrounds. This is the lever that endangers the
  //     heartbeat: with backgroundThrottling enabled, hidden timers get clamped.
  startPhase('C:bg-throttled');
  for (let i = 1; i < N; i++) {
    const wc = views[i]!.webContents as unknown as { setBackgroundThrottling?: (b: boolean) => void };
    if (typeof wc.setBackgroundThrottling === 'function') wc.setBackgroundThrottling(true);
  }
  await sleep(12000); // throttled timers can clamp to ~1/min; give it time to show
  phaseBeats['C'] = beatSnapshot();

  // D — hibernate backgrounds: destroy the WebContents to reclaim RAM/process.
  const beforeHibKB = rendererRssKB();
  const beforeProcs = app.getAppMetrics().length;
  startPhase('D:bg-hibernated');
  for (let i = 1; i < N; i++) {
    try { win.contentView.removeChildView(views[i]!); views[i]!.webContents.close(); views[i] = null; } catch (e) { console.error('hibernate', e); }
  }
  await sleep(6000);
  const afterHibKB = rendererRssKB();
  const afterProcs = app.getAppMetrics().length;

  clearInterval(sampler);

  const A = phaseStats('A:all-active');
  const B = phaseStats('B:bg-unrendered');
  const C = phaseStats('C:bg-throttled');
  const D = phaseStats('D:bg-hibernated');

  // The 4 backgrounded views' heartbeats during each phase (acct-1..4).
  const bgBeats = (snap: ReturnType<typeof beatSnapshot>) => {
    const ids = Object.keys(snap).filter((k) => k !== 'acct-0');
    const beatsArr = ids.map((k) => snap[k].beats);
    const drifts = ids.map((k) => snap[k].maxDrift);
    return { minBeats: Math.min(...beatsArr), maxBeats: Math.max(...beatsArr), maxDriftMs: Math.max(...drifts) };
  };

  const report = {
    config: { views: N, backgroundThrottling: THROTTLE, electron: process.versions.electron, platform: process.platform, note: 'headless xvfb software-render: paint/GPU savings not representative; JS-CPU, RAM and timer behavior are.' },
    phases: { A, B, C, D },
    backgroundHeartbeat: { B_unrendered: bgBeats(phaseBeats['B']), C_throttled: bgBeats(phaseBeats['C']) },
    hibernation: {
      rendererRamReclaimedMB: +((beforeHibKB - afterHibKB) / 1024).toFixed(0),
      processesBefore: beforeProcs,
      processesAfter: afterProcs,
    },
  };

  const line = (k: string, p: ReturnType<typeof phaseStats>) =>
    console.log(`  ${k.padEnd(18)} cpu=${String(p?.avgCpuPct).padStart(5)}%  rendererRAM=${String(p?.rendererMemMB).padStart(4)}MB  procs=${p?.procCount}`);
  console.log('PHASE                 CPU        RAM        PROCS');
  line('A:all-active', A); line('B:bg-unrendered', B); line('C:bg-throttled', C); line('D:bg-hibernated', D);

  console.log(`\nBackground heartbeat (acct-1..4 = should be ~${Math.round(9000 / 1000)}+ beats/phase if alive):`);
  console.log(`  B un-rendered : beats ${report.backgroundHeartbeat.B_unrendered.minBeats}-${report.backgroundHeartbeat.B_unrendered.maxBeats}, maxDrift ${report.backgroundHeartbeat.B_unrendered.maxDriftMs}ms`);
  console.log(`  C throttled   : beats ${report.backgroundHeartbeat.C_throttled.minBeats}-${report.backgroundHeartbeat.C_throttled.maxBeats}, maxDrift ${report.backgroundHeartbeat.C_throttled.maxDriftMs}ms`);
  console.log(`\nHibernation (closed 4 bg views): reclaimed ${report.hibernation.rendererRamReclaimedMB}MB renderer RAM, procs ${beforeProcs} -> ${afterProcs}`);

  const out = path.join(__dirname, '..', `report-throttle-${THROTTLE}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nreport written: ${out}\n`);
  app.quit();
}

app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1); });
