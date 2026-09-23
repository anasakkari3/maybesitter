import type { CommitmentView, TodayGroups } from '../commitments/model';
import type { NextStepRecommendation } from '../../api/schemas/nextStep';
import type { DailyPlan } from '../../api/schemas/plan';

/**
 * One answer to "what matters now" (Round 2, Phase C).
 *
 * Today used to draw three independent server computations one above the
 * other — the next-step card, the plan card, and the list — and each could
 * name a different thing as the thing to do. The list's first item explained
 * itself, the card above it recommended something else, and the plan counted
 * an item the list had already crossed off.
 *
 * This is the reconciliation, as a pure function so it can be driven in a
 * test without rendering:
 *
 *   PRIMARY   exactly one of: quiet · all done · the recommended step · the
 *             list's own top item (when there is no recommendation to show) ·
 *             nothing (an empty day). The recommendation wins when the server
 *             offers one; the list's ranking is the fallback, never a rival.
 *   REST      the day's open items, in the user's own groups (Must → Should →
 *             Nice, #169), with the primary item taken out — it is on the
 *             card, and one thing is shown once.
 *   PLAN      the plan row's state, honest about loading and failure rather
 *             than vanishing, and never counting what the list has resolved.
 *   LATER     a glimpse of the coming days, so Today ends with what is next
 *             rather than with a wall.
 */
export type Primary =
  | { kind: 'quiet' }
  | { kind: 'allDone' }
  | { kind: 'next'; recommendation: NextStepRecommendation; item: CommitmentView | null }
  | { kind: 'fallback'; item: CommitmentView }
  | { kind: 'none' };

export type PlanRow =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'none' }
  | { kind: 'proposed'; placed: number }
  | { kind: 'accepted'; placed: number }
  | { kind: 'dismissed' };

export interface TodayModel {
  primary: Primary;
  /** The open groups with the primary item removed. `finished` is untouched. */
  groups: TodayGroups;
  /** Open items left in the groups, i.e. not counting the primary. */
  openInGroups: number;
  /** Open items on the day including the primary — what "N things open" means. */
  openTotal: number;
  plan: PlanRow;
  later: CommitmentView[];
  /**
   * Every source has answered and none of them has anything to show.
   *
   * Not a predicate over the commitment list: the screen's empty branch draws
   * neither the primary card nor the plan row, so a list-only `isEmpty` put
   * «the day is empty» over a plan that had placed three things and swallowed
   * a plan that had failed to load (F5, found on device 2026-09-22).
   */
  isEmpty: boolean;
}

export interface NextStepInput {
  recommendation: NextStepRecommendation | null | undefined;
  /** `exposure.allowed === false`: the user asked for quiet. */
  silenced: boolean;
  isPending: boolean;
  isError: boolean;
  /**
   * The route *refused* rather than failed — a 403, whose `reason` is
   * `consent_required`, `feature_disabled` or `quiet_mode`.
   *
   * That is an answer: there is no recommendation for this account, as
   * definitely as `state: 'empty'`. It is separated from `isError` because
   * recommendations are off by default, so treating the refusal as "we do not
   * know yet" stopped Today ever calling a day empty again (found on device
   * against the real backend, 2026-09-22).
   */
  unavailable?: boolean;
}

export interface PlanInput {
  plan: DailyPlan | null | undefined;
  isPending: boolean;
  isError: boolean;
}

const OPEN_KEYS = ['must', 'should', 'nice'] as const;

function openItems(groups: TodayGroups): CommitmentView[] {
  return OPEN_KEYS.flatMap((k) => groups[k]);
}

function without(groups: TodayGroups, id: string | null): TodayGroups {
  if (!id) return groups;
  return {
    must: groups.must.filter((c) => c.id !== id),
    should: groups.should.filter((c) => c.id !== id),
    nice: groups.nice.filter((c) => c.id !== id),
    finished: groups.finished,
  };
}

export function composeToday(input: {
  groups: TodayGroups;
  next: NextStepInput;
  plan: PlanInput;
  upcoming: readonly CommitmentView[];
  laterLimit?: number;
}): TodayModel {
  const { groups, next, plan, upcoming, laterLimit = 3 } = input;
  const open = openItems(groups);
  const byId = new Map(open.map((c) => [c.id, c]));

  // ── primary ──
  let primary: Primary;
  const rec = next.recommendation;
  const ready = !!rec && rec.state === 'ready' && !!rec.primaryStep && !next.silenced;
  if (open.length === 0 && groups.finished.length > 0) {
    // Everything the day had is resolved. Said once, calmly, whatever the
    // recommendation route thinks — it may still name a thing from tomorrow.
    primary = { kind: 'allDone' };
  } else if (next.silenced) {
    primary = { kind: 'quiet' };
  } else if (ready && rec.primaryStep) {
    primary = { kind: 'next', recommendation: rec, item: byId.get(rec.primaryStep.commitmentId) ?? null };
  } else {
    // No recommendation to show — none yet, none for this day, or the route
    // failed. The list's own ranking is the answer, not a blank: the first
    // open item of the first non-empty group, Must before Should before Nice
    // (#169). Whether it has a reason to give is a separate question the
    // screen asks with `whyFirstLine`; `topItemFor` answers that one, not this.
    const top = open[0] ?? null;
    primary = top ? { kind: 'fallback', item: top } : { kind: 'none' };
  }

  // The recommended commitment is on the card wherever it lives — on the day
  // or in the week — so it is shown there and nowhere else.
  const primaryId = primary.kind === 'next' ? primary.recommendation.primaryStep?.commitmentId ?? null
    : primary.kind === 'fallback' ? primary.item.id : null;
  const rest = without(groups, primaryId);
  const openInGroups = openItems(rest).length;

  // ── plan ──
  let planRow: PlanRow;
  if (plan.isPending && plan.plan === undefined) planRow = { kind: 'loading' };
  else if (plan.isError) planRow = { kind: 'error' };
  else if (!plan.plan) planRow = { kind: 'none' };
  else if (plan.plan.status === 'dismissed') planRow = { kind: 'dismissed' };
  else if (plan.plan.status === 'accepted') planRow = { kind: 'accepted', placed: plan.plan.scheduled.length };
  else planRow = { kind: 'proposed', placed: plan.plan.scheduled.length };

  // ── later ──
  const todayIds = new Set([...open, ...groups.finished].map((c) => c.id));
  const later = upcoming
    .filter((c) => c.status === 'active' && !todayIds.has(c.id) && c.id !== primaryId)
    .slice(0, laterLimit);

  // ── is the day empty? ──
  // One rule: the day is empty only when every source has answered and none
  // of them has anything to show.
  //
  // `primary.kind === 'none'` is already the list's whole answer — it is the
  // one kind that draws nothing, and it is reached only when the day has no
  // open item, nothing finished (that is `allDone`), no recommendation to
  // show and no request for quiet. So the list is not re-tested here; a
  // second, redundant clause would be a line no mutation could kill.
  const planShowsWork = (planRow.kind === 'proposed' || planRow.kind === 'accepted') && planRow.placed > 0;
  // Pending or failed is *not* an answer. Saying «empty» while a source is
  // still talking is the false empty state itself, and on failure the empty
  // branch would hide the very row that reports it.
  const stillAsking = next.isPending
    || (next.isError && !next.unavailable)
    || plan.isPending
    || plan.isError;

  return {
    primary,
    groups: rest,
    openInGroups,
    openTotal: open.length,
    plan: planRow,
    later,
    isEmpty: primary.kind === 'none' && !planShowsWork && later.length === 0 && !stillAsking,
  };
}