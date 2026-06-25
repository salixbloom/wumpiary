import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, defaultConfig } from '../shared/types';

// Non-secret configuration persisted as JSON in userData. Secrets never live
// here (see vault.ts). Writes are debounced and atomic.

const FILE = () => path.join(app.getPath('userData'), 'config.json');

export class ConfigStore {
  private data: AppConfig;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.data = this.load();
  }

  private load(): AppConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      return mergeDefaults(raw);
    } catch {
      return defaultConfig();
    }
  }

  get(): AppConfig {
    return this.data;
  }

  /** Mutate via callback, then persist. */
  update(mut: (c: AppConfig) => void): AppConfig {
    mut(this.data);
    this.persist();
    return this.data;
  }

  private persist() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      const file = FILE();
      const tmp = `${file}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, file);
      } catch (e) {
        console.error('[config] write failed', e);
      }
    }, 150);
  }

  /** Flush synchronously (e.g. on quit). */
  flush() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    try {
      fs.writeFileSync(FILE(), JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[config] flush failed', e);
    }
  }
}

function mergeDefaults(raw: Partial<AppConfig>): AppConfig {
  const d = defaultConfig();
  return {
    ui: { ...d.ui, ...raw.ui },
    global: { ...d.global, ...raw.global },
    accountsOrder: raw.accountsOrder ?? [],
    accounts: raw.accounts ?? {},
    lastActiveId: raw.lastActiveId ?? null,
  };
}
