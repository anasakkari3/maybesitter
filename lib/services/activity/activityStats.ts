/**
 * The counters behind the weekly Moments (UC-3.15, #201).
 *
 * ── Why this is a counter and not a query ────────────────────────
 *
 * A Moment is "the first thing you ever finished", "the tenth". Those are
 * facts about something that happened, and #201 requires that deleting the
 * commitment afterwards does not unhappen them. Counting the user's *current*
 * completed items would do exactly that: finish ten things, tidy three of them
 * away, and "you have finished ten things" would be withdrawn — the product
 * taking back an acknowledgement because the user cleaned up. So the totals
 * are accumulated forward and never recomputed from what still exists.
 *
 * ── Advanced in the same transaction as the event ────────────────
 *
 * `recordActivityEvents` is called from `writeDomainDiff`'s callers with the
 * very events that transaction is appending, so the counter and the log commit
 * together. A counter bumped after the transaction would drift on every retry
 * and on every crash between the two writes.
 *
 * Transactions re-run on contention, so this reads the stored value each
 * attempt and recomputes from it. It is a function of (stored value, events),
 * never of how many times the callback has run.
 *
 * ── The two counters with no producer yet ────────────────────────
 *
 * `plan_accepted` is emitted by UC-3.10a (#194), which is not built. The rule
 * for it is written here rather than left out, because the alternative is a
 * second change to this file later — and the account that accepts a plan the
 * day #194 lands would otherwise have no `firstPlanAcceptedAt`. Nothing emits
 * that event today, so the branch is simply never taken.
 */
import { STATS, userSubDoc, type StorageReader, type StorageTransaction } from '../../storage';
import type { DomainEvent } from '../../../src/domain/stateMachine';

/** The single document these counters live in: `users/{uid}/stats/activity`. */
export const ACTIVITY_STATS_DOC = 'activity';

/** The completion totals worth saying something about, ascending. */
export const DONE_MILESTONES = [10, 25, 50, 100] as const;
export type DoneMilestone = (typeof DONE_MILESTONES)[number];

export interface ActivityStats {
  /** Every completion this account has ever recorded. Never decreases. */
  doneTotal: number;
  firstCaptureAt: string | null;
  firstDoneAt: string | null;
  /** Written by UC-3.10a (#194) once it emits `plan_accepted`. */
  firstPlanAcceptedAt: string | null;
  /** `{ "10": instant }` — when each threshold was crossed, so it has a date. */
  doneMilestonesAt: Record<string, string>;
}

export function emptyActivityStats(): ActivityStats {
  return { doneTotal: 0, firstCaptureAt: null, firstDoneAt: null, firstPlanAcceptedAt: null, doneMilestonesAt: {} };
}

export function activityStatsPath(uid: string): string {
  return userSubDoc(uid, STATS, ACTIVITY_STATS_DOC);
}

/** A stored document, made whole: an older one may predate a field. */
export function normalizeActivityStats(stored: Partial<ActivityStats> | null | undefined): ActivityStats {
  const base = emptyActivityStats();
  if (!stored) return base;
  return {
    doneTotal: Number.isInteger(stored.doneTotal) && (stored.doneTotal as number) >= 0 ? stored.doneTotal as number : 0,
    firstCaptureAt: typeof stored.firstCaptureAt === 'string' ? stored.firstCaptureAt : null,
    firstDoneAt: typeof stored.firstDoneAt === 'string' ? stored.firstDoneAt : null,
    firstPlanAcceptedAt: typeof stored.firstPlanAcceptedAt === 'string' ? stored.firstPlanAcceptedAt : null,
    doneMilestonesAt: stored.doneMilestonesAt && typeof stored.doneMilestonesAt === 'object'
      ? { ...stored.doneMilestonesAt }
      : {},
  };
}

export async function readActivityStats(reader: StorageReader, uid: string): Promise<ActivityStats> {
  return normalizeActivityStats(await reader.get<Partial<ActivityStats>>(activityStatsPath(uid)));
}

/**
 * The counters after these events, or the same object when none of them count.
 *
 * Pure: the same inputs give the same answer however many times a transaction
 * retries. `earliest` rather than "set if absent" so that events arriving out
 * of order — a replayed confirm, a backfill — cannot move a first-ever date
 * forwards.
 */
export function advanceActivityStats(current: ActivityStats, events: readonly DomainEvent[]): ActivityStats {
  let next = current;
  let changed = false;
  const bump = (patch: Partial<ActivityStats>): void => {
    next = { ...next, ...patch };
    changed = true;
  };

  for (const event of events) {
    if (event.type === 'draft_created') {
      const first = earliest(next.firstCaptureAt, event.at);
      if (first !== next.firstCaptureAt) bump({ firstCaptureAt: first });
      continue;
    }
    if (event.type === 'plan_accepted') {
      const first = earliest(next.firstPlanAcceptedAt, event.at);
      if (first !== next.firstPlanAcceptedAt) bump({ firstPlanAcceptedAt: first });
      continue;
    }
    if (event.type !== 'commitment_completed') continue;

    const doneTotal = next.doneTotal + 1;
    const patch: Partial<ActivityStats> = { doneTotal };
    const firstDoneAt = earliest(next.firstDoneAt, event.at);
    if (firstDoneAt !== next.firstDoneAt) patch.firstDoneAt = firstDoneAt;
    const milestone = DONE_MILESTONES.find((threshold) => threshold === doneTotal);
    if (milestone !== undefined && next.doneMilestonesAt[String(milestone)] === undefined) {
      patch.doneMilestonesAt = { ...next.doneMilestonesAt, [String(milestone)]: event.at };
    }
    bump(patch);
  }

  return changed ? next : current;
}

/** Writes the advanced counters, and nothing at all when none of them moved. */
export function recordActivityEvents(
  tx: StorageTransaction,
  uid: string,
  current: ActivityStats,
  events: readonly DomainEvent[],
): void {
  const next = advanceActivityStats(current, events);
  if (next === current) return;
  tx.set<ActivityStats>(activityStatsPath(uid), next);
}

function earliest(existing: string | null, candidate: string): string {
  if (!existing) return candidate;
  return candidate < existing ? candidate : existing;
}
