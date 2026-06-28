import enUS from './locales/en_US.json';
import enCLAUDE from './locales/en_CLAUDE.json';

export type LocaleId = 'en_US' | 'en_CLAUDE';

export const LOCALES: Record<LocaleId, string> = {
  en_US: 'English (US)',
  en_CLAUDE: 'English (Claude)',
};

export const DEFAULT_LOCALE: LocaleId = 'en_US';

export const LOCALE_IDS = Object.keys(LOCALES) as LocaleId[];

const strings: Record<LocaleId, Record<string, string>> = {
  en_US: enUS,
  en_CLAUDE: enCLAUDE,
};

export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

export function createT(locale: string): TFunction {
  const map = strings[(locale as LocaleId)] ?? strings[DEFAULT_LOCALE];
  const fallback = strings[DEFAULT_LOCALE];
  return (key: string, vars?: Record<string, string | number>) => {
    let s = map[key] ?? fallback[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(`{${k}}`, String(v));
      }
    }
    return s;
  };
}
