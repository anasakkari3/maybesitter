import type { Strings } from '../i18n/strings';
import type { Palette } from '../theme/tokens';
import type { Imp } from './types';

/** The importance, in the user's words (must · should · nice). */
export const impLabel = (i: Imp, t: Strings) => (i === 'must' ? t.mustL : i === 'should' ? t.shouldL : t.niceL);

export function impColors(i: Imp, p: Palette) {
  if (i === 'must') return { bg: p.wms, fg: p.wm };
  if (i === 'should') return { bg: p.acs, fg: p.ac };
  return { bg: p.sf2, fg: p.mu };
}
