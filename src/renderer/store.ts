import { create } from 'zustand';
import type { AppState } from '../shared/types';

interface Store {
  state: AppState | null;
  setState: (s: AppState) => void;
}

export const useStore = create<Store>((set) => ({
  state: null,
  setState: (s) => set({ state: s }),
}));

export const api = window.wumpiary;
