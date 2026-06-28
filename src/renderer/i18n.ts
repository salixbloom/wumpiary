import { useStore } from './store';
import { createT, DEFAULT_LOCALE, type TFunction } from '../shared/i18n';

export function useT(): TFunction {
  const locale = useStore((s) => s.state?.config.ui.locale ?? DEFAULT_LOCALE);
  return createT(locale);
}
