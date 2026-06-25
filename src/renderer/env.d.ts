/// <reference types="vite/client" />
import type { WumpiaryApi } from '../preload/chrome';

declare global {
  interface Window {
    wumpiary: WumpiaryApi;
  }
}

export {};
