/**
 * The plan ledger as a second source of activity (UC-3.15 #201, UC-3.10a #194).
 *
 * ── Why activity reads two collections ───────────────────────────
 *
 * #194 records what a person did with their plan in `users/{uid}/planEvents`,
 * and on purpose not in `users/{uid}/events`: the domain log is replayed by the
 * reducer into `DomainState`, a plan is not an aggregate the reducer owns, and
 * a record it does not know is a record it has to skip (planStore's header).
 * That decision stands. So rather than write a second copy of the acceptance
 * into the domain log, activity reads the ledger where it already is, and
 * merges the two by the same total order — `at` descending, the stored `id`
 * ascending — so a page cursor names a record in either.
 *
 * ── The same allowlist discipline as the domain log ──────────────
 *
 * Only `plan_accepted` is shown. The rest of the ledger is named below with
 * its reason, and `tests/activity/planActivity.test.ts` reads `PlanEventType`
 * out of planStore so that a sixth ledger event cannot reach somebody's
 * history without a decision here.
 */
import { PLAN_EVENTS, userCol, type StorageReader } from '../../storage';
import type { PlanEvent } from '../dailyPlan/planStore';
import type { DomainEventRecord } from '../mobile/eventLog';
import type { ActivityKind } from './activityProjection';

export const ACTIVITY_KIND_BY_PLAN_EVENT_TYPE: Readonly<Record<string, ActivityKind>> = Object.freeze({
  plan_accepted: 'plan_accepted',
});

/** Ledger events that exist and are deliberately not activity, with why. */
export const PLAN_EVENTS_NOT_USER_FACING: Readonly<Record<string, string>> = Object.freeze({
  plan_proposed: 'the morning job built it; the person has not done anything yet',
  plan_regenerated: 'a rebuild is the system producing a proposal, not an outcome',
  plan_edited: 'moving a block is a step on the way to a plan, not something done',
  // "Not today" is a legitimate answer, and listing it in a record of what
  // somebody did reads as a tally of plans they turned down.
  plan_dismissed: 'setting a plan aside must not become a count of refusals',
  // Protecting an hour is a statement about how the *planner* should behave
  // from now on (#522), not something the person finished. It belongs in the
  // ledger — a placement the planner stops moving needs a record of who asked —
  // and not in a history of what somebody did.
  plan_protected: 'declaring a block protected tunes the planner; it is not an outcome',
  // A view is not something the person did (#533). It is recorded so R3 can
  // learn when the plan is usually looked at; showing it in a history of what
  // somebody did would read as a tally of glances.
  plan_opened: 'looking at a plan is not doing it',
});

/**
 * A ledger entry, shaped as the record the projection and the summary read.
 *
 * No aggregate: the entry is about a day, not a commitment, so the projection
 * gives it a null commitment rather than attributing it to an id nothing has.
 * The plan's local date travels in the payload so the client can say which
 * day the plan was for.
 */
export function planEventAsRecord(event: PlanEvent): DomainEventRecord {
  return {
    id: event.id,
    type: event.type,
    at: event.at,
    aggregateId: '',
    payload: { planDate: event.date },
  };
}

/** How far into the ledger a legacy first acceptance is looked for. */
export const LEGACY_PLAN_SCAN = 50;

/**
 * The first `plan_accepted` among the ledger's oldest rows, or null.
 *
 * For accounts that accepted a plan between #194 landing and the counter
 * learning about it: #194 wrote the ledger entry and no counter. Read only
 * while the counter is still unset — by the summary, and by `acceptPlan`,
 * which folds it into the counter inside its own transaction so the date
 * survives the counter being set by a later acceptance. The ledger is not
 * something a person can tidy away (only a wipe removes it, and a wipe removes
 * the counter too), so reading it cannot withdraw a Moment.
 *
 * Bounded, oldest first: every legacy acceptance is among an account's
 * earliest ledger rows, and one past the scan happened after the counter
 * existed, so the counter already holds it.
 */
export async function earliestLedgerAcceptance(reader: StorageReader, uid: string): Promise<string | null> {
  const rows = await reader.list<PlanEvent>(userCol(uid, PLAN_EVENTS), {
    orderBy: { field: 'at', direction: 'asc' },
    limit: LEGACY_PLAN_SCAN,
  });
  let earliest: string | null = null;
  for (const row of rows) {
    if (row.data.type === 'plan_accepted' && (earliest === null || row.data.at < earliest)) earliest = row.data.at;
  }
  return earliest;
}
