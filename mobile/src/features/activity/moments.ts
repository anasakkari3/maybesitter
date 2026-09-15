import type { Strings } from '../../i18n/strings';
import { knownMomentId, type Moment } from '../../api/schemas/activity';

/**
 * A Moment's id → the words for it (UC-3.15, #201).
 *
 * `first_plan_accepted` is in the map although nothing can reach it yet:
 * UC-3.10a (#194) emits the event it comes from. A build that shipped without
 * the copy would show a Moment with no words the day that lands.
 */
export interface NamedMoment {
  moment: Moment;
  label: string;
}

const MOMENT_KEY: Record<string, keyof Strings> = {
  first_capture: 'activityMomentFirstCapture',
  first_done: 'activityMomentFirstDone',
  first_plan_accepted: 'activityMomentFirstPlan',
  done_10: 'activityMomentDone10',
  done_25: 'activityMomentDone25',
  done_50: 'activityMomentDone50',
  done_100: 'activityMomentDone100',
};

/**
 * The Moments this build has words for, in the order the server sent them.
 *
 * A Moment whose id this build does not know is skipped rather than printed as
 * its own enum — the same rule the feedback history uses for a decision it has
 * no copy for.
 */
export function namedMoments(moments: readonly Moment[], t: Strings): NamedMoment[] {
  const named: NamedMoment[] = [];
  for (const moment of moments) {
    if (!knownMomentId(moment.id)) continue;
    const key = MOMENT_KEY[moment.id];
    const label = key ? (t[key] as unknown as string) : '';
    if (typeof label === 'string' && label) named.push({ moment, label });
  }
  return named;
}
