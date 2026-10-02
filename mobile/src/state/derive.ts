import type { Strings } from '../i18n/strings';
import type { Palette } from '../theme/tokens';
import type { Imp } from './types';

/**
 * The importance, in the user's words (must · should · nice).
 *
 * The same words the Today card, the plan, the review and the edit sheet use
 * (`todayGroup*`). Details used to read a second vocabulary — «مستحسن» on the
 * screen where the card said «يُفضّل» (audit 2026-10-03, #14) — so the level
 * has one name everywhere.
 */
export const impLabel = (i: Imp, t: Strings) => (i === 'must' ? t.todayGroupMust : i === 'should' ? t.todayGroupShould : t.todayGroupNice);

export function impColors(i: Imp, p: Palette) {
  if (i === 'must') return { bg: p.wms, fg: p.wm };
  if (i === 'should') return { bg: p.acs, fg: p.ac };
  return { bg: p.sf2, fg: p.mu };
}
