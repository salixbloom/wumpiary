import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api, useStore } from './store';
import './styles.css';

// Sync app state from main.
api.getState().then(useStore.getState().setState);
api.onState(useStore.getState().setState);

// Per-account chimes are driven from here so each account can have its own sound.
api.onPlayChime(({ chime }) => {
  try {
    if (chime && chime !== 'default') {
      const a = new Audio(chime.startsWith('file:') ? chime : `file://${chime}`);
      a.play().catch(() => undefined);
    } else {
      // built-in default blip
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 660;
      gain.gain.value = 0.05;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
      osc.onended = () => ctx.close();
    }
  } catch {
    /* audio not available */
  }
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
