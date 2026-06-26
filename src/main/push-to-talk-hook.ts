import type { GlobalConfig, PushToTalkStatus } from '../shared/types';

type HookEvent = {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

type UiohookModule = typeof import('uiohook-napi');

export class PushToTalkHook {
  private hook: UiohookModule['uIOhook'] | null = null;
  private keys: UiohookModule['UiohookKey'] | null = null;
  private targetKeycode: number | null = null;
  private config: GlobalConfig['pushToTalk'] | null = null;
  private active = false;
  private pressed = false;
  private error: string | null = null;

  constructor(private onPressed: (pressed: boolean) => void) {}

  configure(ptt: GlobalConfig['pushToTalk']) {
    if (!ptt.enabled || isModifierCode(ptt.key)) {
      this.stop();
      this.config = null;
      this.error = ptt.enabled ? 'Push to Talk needs a non-modifier key.' : null;
      return;
    }

    this.config = ptt;
    this.targetKeycode = this.keycodeFor(ptt.key);
    if (this.targetKeycode === null) {
      this.error = `Unsupported key: ${ptt.key}`;
      this.stop();
      return;
    }

    const mod = this.load();
    if (!mod) return;
    this.start(mod);
  }

  stop() {
    this.setPressed(false);
    if (this.hook && this.active) {
      try {
        this.hook.stop();
      } catch {
        /* ignore */
      }
    }
    this.active = false;
  }

  status(): PushToTalkStatus {
    if (this.error) return { available: false, active: false, error: this.error };
    return { available: !!this.hook, active: this.active };
  }

  private load(): UiohookModule | null {
    if (this.hook && this.keys) return { uIOhook: this.hook, UiohookKey: this.keys } as UiohookModule;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('uiohook-napi') as UiohookModule;
      this.hook = mod.uIOhook;
      this.keys = mod.UiohookKey;
      this.hook.on('keydown', (event) => this.onKeyDown(event));
      this.hook.on('keyup', (event) => this.onKeyUp(event));
      this.error = null;
      return mod;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Unable to load uiohook-napi';
      this.hook = null;
      this.keys = null;
      return null;
    }
  }

  private start(mod: UiohookModule) {
    if (this.active) return;
    try {
      mod.uIOhook.start();
      this.active = true;
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Unable to start global keyboard hook';
      this.active = false;
      this.setPressed(false);
    }
  }

  private onKeyDown(event: HookEvent) {
    if (this.isMatch(event)) this.setPressed(true);
  }

  private onKeyUp(event: HookEvent) {
    if (event.keycode === this.targetKeycode) this.setPressed(false);
  }

  private isMatch(event: HookEvent) {
    const ptt = this.currentConfig();
    if (!ptt || this.targetKeycode === null) return false;
    return (
      event.keycode === this.targetKeycode &&
      !!event.ctrlKey === ptt.ctrl &&
      !!event.altKey === ptt.alt &&
      !!event.shiftKey === ptt.shift &&
      !!event.metaKey === ptt.meta
    );
  }

  private currentConfig(): GlobalConfig['pushToTalk'] | null {
    return this.config;
  }

  private setPressed(pressed: boolean) {
    if (this.pressed === pressed) return;
    this.pressed = pressed;
    this.onPressed(pressed);
  }

  private keycodeFor(code: string): number | null {
    const keys = this.keys ?? this.load()?.UiohookKey;
    if (!keys) return null;
    const normalized = normalizeKeyCode(code);
    if (normalized) return keys[normalized as keyof typeof keys] ?? null;
    if (code.startsWith('Key')) return keys[code.slice(3) as keyof typeof keys] ?? null;
    if (code.startsWith('Digit')) return keys[code.slice(5) as keyof typeof keys] ?? null;
    return keys[code as keyof typeof keys] ?? null;
  }
}

function normalizeKeyCode(code: string) {
  const map: Record<string, string> = {
    ControlLeft: 'Ctrl',
    ControlRight: 'CtrlRight',
    AltLeft: 'Alt',
    AltRight: 'AltRight',
    ShiftLeft: 'Shift',
    ShiftRight: 'ShiftRight',
    MetaLeft: 'Meta',
    MetaRight: 'MetaRight',
  };
  return map[code] ?? null;
}

function isModifierCode(code: string) {
  return code === 'ControlLeft' || code === 'ControlRight' || code === 'AltLeft' || code === 'AltRight' || code === 'ShiftLeft' || code === 'ShiftRight' || code === 'MetaLeft' || code === 'MetaRight';
}
