import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api, useStore } from './store';
import './styles.css';

// Sync app state from main.
api.getState().then(useStore.getState().setState);
api.onState(useStore.getState().setState);

// Renderer owns short UI sound playback; main only decides which sound to play.
function playSound(sound: string) {
  try {
    if (sound && sound !== 'default' && sound !== 'none') {
      const a = new Audio(isSoundUrl(sound) ? sound : `file://${sound}`);
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
}

function isSoundUrl(sound: string) {
  return /^[a-z][a-z0-9+.-]*:/i.test(sound);
}

// Per-account chimes are driven from here so each account can have its own sound.
api.onPlayChime(({ chime }) => playSound(chime));
api.onPlaySound(({ sound }) => playSound(sound));

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
