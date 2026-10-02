import type { CommitmentView, TodayGroups } from '../commitments/model';
import type { NextStepRecommendation } from '../../api/schemas/nextStep';
import type { DailyPlan } from '../../api/schemas/plan';
import { planRows } from '../plan/lateDay';

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
/**
 * Why there is no card (UAT round 3, N12). `mode`: the person's own quiet-mode
 * switch, on until they turn it off. `hours`: inside their quiet hours, which
 * end by themselves at `until`. `block`: inside a weekly fixed block
 * («ثابت أسبوعي» — the Saturday shift), which ends by itself at `until` on
 * the block's clock. `paused`: anything else the route went quiet
 * for — the kill switch — which nobody on this phone can turn off.
 */
export type QuietWhy = 'mode' | 'hours' | 'block' | 'paused';

export type Primary =
  | { kind: 'quiet'; why: QuietWhy; until: string | null }
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
  /** `exposure.reason` when silenced: `quiet_mode`, `quiet_hours` or `kill_switch_active`. */
  silencedReason?: string | undefined;
  /** `exposure.until`: the `HH:mm` quiet hours end, when that is the reason. */
  quietUntil?: string | undefined;
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

/** The server's `FIXED_EVENT_LEAD_MS`: an event at an hour is a step only in its last hour. */
export const FIXED_EVENT_LEAD_MS = 60 * 60_000;

function eventNotYetClose(item: CommitmentView, nowMs: number): boolean {
  if (!item.timedEvent || !item.shownAt) return false;
  const at = Date.parse(item.shownAt);
  return Number.isFinite(at) && at - nowMs > FIXED_EVENT_LEAD_MS;
}

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
  /** The moment Today is drawn for; the phone's clock when absent. */
  now?: Date;
}): TodayModel {
  const { groups, next, plan, upcoming, laterLimit = 3 } = input;
  const nowMs = (input.now ?? new Date()).getTime();
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
    // Quiet hours used to be drawn as quiet mode — «ما رح نقترح إشي لحد ما
    // تطفّيه» at 04:00 with quiet mode off (UAT round 3, N12). They are told
    // apart here, once, for whatever draws the card. A missing reason is read
    // as quiet mode, which is what every silence was drawn as before.
    const why: QuietWhy = next.silencedReason === 'quiet_hours' ? 'hours'
      : next.silencedReason === 'weekly_block' ? 'block'
        : next.silencedReason === undefined || next.silencedReason === 'quiet_mode' ? 'mode' : 'paused';
    primary = { kind: 'quiet', why, until: why === 'hours' || why === 'block' ? next.quietUntil ?? null : null };
  } else if (ready && rec.primaryStep) {
    primary = { kind: 'next', recommendation: rec, item: byId.get(rec.primaryStep.commitmentId) ?? null };
  } else {
    // No recommendation to show — none yet, none for this day, or the route
    // failed. The list's own ranking is the answer, not a blank: the first
    // open item of the first non-empty group, Must before Should before Nice
    // (#169). Whether it has a reason to give is a separate question the
    // screen asks with `whyFirstLine`; `topItemFor` answers that one, not this.
    // An appointment on a day is not a step: it stays in its group as the
    // day's context, and the card goes to the first thing to do (N18).
    // Nor is an event at an hour still more than its last hour away — the
    // exam tomorrow at 10:00, the night out at 21:00 (audit 2026-10-03 #2):
    // the server holds them back the same way (`nextStepPreparation.ts`).
    const top = open.find((c) => !c.allDayEvent && !eventNotYetClose(c, nowMs)) ?? null;
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
  // What has a time on the day: what the planner placed *and* what is pinned
  // to a time (`fixed`), as the plan screen draws them. Counting `scheduled`
  // alone said «ما في إشي إله وقت اليوم» over an accepted plan whose one row
  // was dinner at 20:00 (UAT round 6, N-h).
  else if (plan.plan.status === 'accepted') planRow = { kind: 'accepted', placed: planRows(plan.plan).length };
  else planRow = { kind: 'proposed', placed: planRows(plan.plan).length };

  // ── later ──
  const todayIds = new Set([...open, ...groups.finished].map((c) => c.id));
  const later = upcoming
    .filter((c) => c.status === 'active' && !todayIds.has(c.id) && c.id !== primaryId)
    .slice(0, laterLimit);

  // ── is the day empty? ──
  // One rule: the day is empty only when every source has answered and none
  // of them has anything to show.
  //
  // `primary.kind === 'none'` is the one kind that draws nothing. It is
  // reached with no open item, nothing finished (that is `allDone`), no
  // recommendation to show and no request for quiet — or when every open
  // item is an appointment on the day (N18), which is still a day with
  // something on it. So the open count is part of the answer.
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
    isEmpty: primary.kind === 'none' && open.length === 0 && !planShowsWork && later.length === 0 && !stillAsking,
  };
}