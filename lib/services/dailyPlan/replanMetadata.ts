import type { Plan } from '../../../src/contracts/v1/planningContracts';
import type { StoredDailyPlan, StoredExplanation } from './planStore';
import { explanationFactsFrom, templateExplanation } from './explanationValidator';

/** Replace superseded time-specific prose without another model call (#586).
 * Kept removals are absent from the visible day and from its explanation.
 * Templates use counts and times only; no commitment text needs fetching.
 */
export function replanExplanation(
  plan: Plan,
  context: Pick<StoredDailyPlan, 'timezone' | 'locale'>,
): StoredExplanation {
  const facts = explanationFactsFrom(plan, new Map(), context.timezone, context.locale);
  return { text: templateExplanation(facts), locale: context.locale, source: 'template', validated: true };
}
