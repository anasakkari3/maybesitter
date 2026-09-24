/**
 * A morning plan's push, kept until it is delivered or deliberately dropped (#431).
 *
 * ── Three ways the plan was stored and the phone stayed silent ───
 *
 *  1. **Quiet hours.** A delivery time inside the account's own quiet hours
 *     built the plan, and `sendToUser` suppressed the push. Nothing sent it
 *     later.
 *  2. **A throwing send.** FCM's `internal-error` was caught (#426), but the
 *     claim had already moved `nextRunAt` to tomorrow, so the next sweep saw
 *     nothing due.
 *  3. **A crash between the plan write and the send.** #184 gave the push a
 *     dedupe lock, not a queue, so nothing noticed.
 *
 * All three are one state — the plan document exists and no push was
 * delivered — so they get one mechanism: a **push-pending marker** on the plan
 * document (`StoredDailyPlan.pushPending`), and a push-only retry the morning
 * sweep re-arms from it. A retry never rebuilds: it reads the stored plan's
 * date and locale and sends the same generic notice. The plan is not touched.
 *
 * ── The marker is written with the plan, and that is the crash case ──
 *
 * `createIfAbsent` stores the plan *with* the marker, in one write. Nothing is
 * in between for a crash to fall into: if the plan exists and the push did not
 * report, the marker says so. It is cleared only by a confirmed send or by a
 * deliberate drop, never by the attempt starting.
 *
 * The marker the plan is created with is already a claim on attempt 1: reason
 * `in_flight`, `nextAttemptAt` a lease `PLAN_PUSH_LEASE_MS` ahead. The process
 * that created the plan sends the first push itself, and no sweep can take the
 * push until that lease runs out — which it only does if that process died.
 *
 * ── Exactly once, in the two layers the morning build already uses ──
 *
 *  1. **The claim.** `claimPlanPushRetry` reads the marker and advances
 *     `nextAttemptAt` to a new lease in one transaction on the plan document,
 *     the discipline `claimDueDeliveryOutcome` applies to `nextRunAt`. Two
 *     sweeps that overlap serialise: the loser re-reads a lease in the future
 *     and claims nothing.
 *  2. **The dedupe key.** The retry reuses the `pushLog` key of the attempt
 *     before it, `plan:{date}`, unless that attempt's send was seen to throw.
 *     So a sweep that re-takes an expired lease after a process died *after*
 *     sending meets the key that send took and answers `duplicate` — which is
 *     read as delivered, and the marker is cleared.
 *
 * A key is abandoned only when its send was **observed to throw**. `sendToUser`
 * takes the key before calling FCM and keeps it when FCM fails (its header:
 * "a caller that genuinely needs a retry after a partial failure mints a new
 * key"), so a retry on the same key would only ever answer `duplicate`. That is
 * why the marker counts `failedSends` beside `attempts`: the key is
 * `plan:{date}` until a send throws, then `plan:{date}:retry{n}`.
 *
 * What that cannot make exactly-once is FCM itself: `internal-error` is
 * ambiguous, and FCM may have delivered before failing. The re-send is shown
 * under the same notification identifier (`collapseId: plan:{date}`, which
 * becomes `apns-collapse-id` and the Android tag), so a phone that did get the
 * first one has it *replaced*, not doubled.
 *
 * ── When a morning plan stops being worth a push ─────────────────
 *
 * `MORNING_PLAN_PUSH_CUTOFF_LOCAL_TIME`: see the constant.
 *
 * ── Content-free ──────────────────────────────────────────────────
 *
 * The marker is two counts, one instant and a reason word. It never holds a
 * title, the notification text, or anything the plan says; the log lines name
 * a reason and nothing else — no uid, no date.
 */
import type { StorageAdapter } from '../../storage';
import { PLANS, PLAN_EVENTS, requireUserId, userCol } from '../../storage/paths';
import type { UserLocale } from '../../storage/userDocument';
import { wallClockAt } from '../../planning/shared/time';
import { readQuietHours } from '../../push/quietHours';
import { localDateOf, nextDeliveryAt, parseDeliveryLocalTime } from './planSettings';
import { planPath, type StoredDailyPlan } from './planStore';
import type { PlanPushSender } from './dailyPlanService';

/**
 * Why the push is still owed.
 *
 * - `in_flight`: an attempt was claimed and has not reported. `nextAttemptAt`
 *   is its lease; past it, the attempt is presumed dead.
 * - `quiet_hours`: suppressed; `nextAttemptAt` is the end of the window.
 * - `send_failed`: the send threw; `nextAttemptAt` is a short delay away.
 */
export type PlanPushPendingReason = 'in_flight' | 'quiet_hours' | 'send_failed';

/** The marker. Counts, one instant and a reason — never content. */
export interface PlanPushPending {
  /** Sends started for this plan's push, the morning's own included. */
  readonly attempts: number;
  /** Of those, the ones whose send threw. Chooses the dedupe key; see the header. */
  readonly failedSends: number;
  /** The earliest the sweep may take this push. */
  readonly nextAttemptAt: string;
  readonly reason: PlanPushPendingReason;
}

/**
 * How many sends one plan's push may start: the morning's own attempt and
 * three retries. Enough to ride out a quiet window plus a couple of transient
 * FCM failures; few enough that an account whose sends always fail stops
 * costing a sweep slot within the morning.
 */
export const MAX_PLAN_PUSH_ATTEMPTS = 4;

/**
 * How long a claimed attempt is presumed alive. A send is one Firestore
 * transaction and one FCM call per device — seconds — so an attempt still
 * `in_flight` after five minutes belongs to a process that is gone.
 */
export const PLAN_PUSH_LEASE_MS = 5 * 60_000;

/** How long after a thrown send the next attempt waits. */
export const PLAN_PUSH_RETRY_DELAY_MS = 5 * 60_000;

/**
 * The local time on the plan's own date from which a pending push is dropped
 * instead of sent (#431's open question, decided).
 *
 * The notification says "Your plan for today is ready". At 08:00 for a 07:30
 * delivery that is still true and still useful: the day it plans has barely
 * started. Local noon is where that stops. Half the waking day is gone, the
 * plan's morning blocks are in the past, and a push then reads as a late
 * reminder about a morning that already happened — noise, and the kind of
 * noise people switch notifications off over. So a retry is sent while the
 * account's local clock on the plan's date is before 12:00, and dropped at or
 * after it, or on any later date. The plan itself is untouched and stays in
 * the app; only the push is given up.
 *
 * This bounds **retries** only. The morning's own attempt is sent at the time
 * the user chose, whatever that time is.
 */
export const MORNING_PLAN_PUSH_CUTOFF_LOCAL_TIME = '12:00';

/** Pending pushes examined per sweep, as `DAILY_PLAN_BATCH` is for builds. */
export const PLAN_PUSH_RETRY_BATCH = 50;

/** Why a pending push was given up. A word, and the only thing logged. */
export type PlanPushDropReason =
  /** Past `MORNING_PLAN_PUSH_CUTOFF_LOCAL_TIME`, or a later date. */
  | 'stale'
  /** `MAX_PLAN_PUSH_ATTEMPTS` sends started and none delivered. */
  | 'exhausted'
  /** The user has already opened, or acted on, the plan. */
  | 'opened'
  /** The key was already taken: delivered by an attempt that did not report. */
  | 'duplicate'
  | 'no_devices'
  /** Deleted, revoked or paused: the account has told us to stop. */
  | 'no_access'
  /** A sender status this module does not know; not retried. */
  | 'refused'
  /** A marker this build cannot read. */
  | 'unreadable';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The marker a plan is created with: attempt 1, claimed by its creator. */
export function firstPushPending(now: Date): PlanPushPending {
  return { attempts: 1, failedSends: 0, nextAttemptAt: iso(now.getTime() + PLAN_PUSH_LEASE_MS), reason: 'in_flight' };
}

/** `plan:{date}` until a send throws; a fresh key per thrown send after that. */
export function planPushDedupeKey(date: string, failedSends: number): string {
  return failedSends === 0 ? `plan:${date}` : `plan:${date}:retry${failedSends}`;
}

/**
 * Whether a push for the plan of `date` would no longer read as this
 * morning's. `timezone` is the plan's own: its date is a date in that zone.
 */
export function isPastMorningCutoff(date: string, timezone: string, at: Date): boolean {
  const today = localDateOf(at.toISOString(), timezone);
  if (today > date) return true;
  if (today < date) return false;
  const { hour, minute } = parseDeliveryLocalTime(MORNING_PLAN_PUSH_CUTOFF_LOCAL_TIME);
  const local = wallClockAt(at.getTime(), timezone);
  return local.hour * 60 + local.minute >= hour * 60 + minute;
}

/** The plan document with no marker: absent, never null, so no range query returns it. */
function withoutPushPending(stored: StoredDailyPlan): StoredDailyPlan {
  const { pushPending: _cleared, ...rest } = stored;
  return rest;
}

function readablePending(value: unknown): PlanPushPending | null {
  if (!value || typeof value !== 'object') return null;
  const pending = value as Record<string, unknown>;
  if (!Number.isInteger(pending.attempts) || (pending.attempts as number) < 0) return null;
  if (!Number.isInteger(pending.failedSends) || (pending.failedSends as number) < 0) return null;
  if (typeof pending.nextAttemptAt !== 'string' || !Number.isFinite(Date.parse(pending.nextAttemptAt))) return null;
  if (pending.reason !== 'in_flight' && pending.reason !== 'quiet_hours' && pending.reason !== 'send_failed') return null;
  return value as PlanPushPending;
}

export type PlanPushClaim =
  | {
    readonly kind: 'claimed';
    readonly attempt: number;
    readonly dedupeKey: string;
    readonly locale: UserLocale;
  }
  | { readonly kind: 'not_due' }
  | { readonly kind: 'dropped'; readonly reason: PlanPushDropReason };

/**
 * Takes the next attempt of this plan's push, or drops the push, or says it
 * is not due. One transaction on the plan document.
 *
 * The ledger read for `plan_opened` (#533) is inside the transaction: it is a
 * query of the account's own `planEvents` for this date, limit 1, and an open
 * appended while this runs moves the read set and retries the claim.
 */
export async function claimPlanPushRetry(
  uid: string,
  date: string,
  now: Date,
  storage: StorageAdapter,
): Promise<PlanPushClaim> {
  const path = planPath(uid, date);
  return storage.runTransaction<PlanPushClaim>(async (tx) => {
    const stored = await tx.get<StoredDailyPlan>(path);
    if (!stored || stored.pushPending === undefined) return { kind: 'not_due' };
    const pending = readablePending(stored.pushPending);
    if (pending && Date.parse(pending.nextAttemptAt) > now.getTime()) return { kind: 'not_due' };
    // Every read before any write: Firestore refuses the other order.
    const opens = await tx.list(userCol(uid, PLAN_EVENTS), {
      where: [['type', '==', 'plan_opened'], ['date', '==', date]],
      limit: 1,
    });

    const drop = (reason: PlanPushDropReason): PlanPushClaim => {
      tx.set<StoredDailyPlan>(path, withoutPushPending(stored));
      return { kind: 'dropped', reason };
    };
    if (!pending) return drop('unreadable');
    if (isPastMorningCutoff(stored.date, stored.timezone, now)) return drop('stale');
    if (pending.attempts >= MAX_PLAN_PUSH_ATTEMPTS) return drop('exhausted');
    // Opened, or already acted on: accepted, edited and dismissed all mean the
    // person has had the plan in front of them.
    if (opens.length > 0 || stored.status !== 'proposed') return drop('opened');

    const attempt = pending.attempts + 1;
    tx.set<StoredDailyPlan>(path, {
      ...stored,
      pushPending: {
        attempts: attempt,
        failedSends: pending.failedSends,
        nextAttemptAt: iso(now.getTime() + PLAN_PUSH_LEASE_MS),
        reason: 'in_flight',
      },
    });
    return { kind: 'claimed', attempt, dedupeKey: planPushDedupeKey(date, pending.failedSends), locale: stored.locale };
  });
}

/** What one attempt came to, as the sender reported it. */
export type PlanPushAttemptResult =
  /** `status` null: the sender reported nothing, which is taken as sent. */
  | { readonly kind: 'reported'; readonly status: string | null }
  | { readonly kind: 'threw' };

export type PlanPushRecord =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'rescheduled'; readonly at: string }
  | { readonly kind: 'dropped'; readonly reason: PlanPushDropReason }
  /** The marker is no longer this attempt's: nothing was written. */
  | { readonly kind: 'superseded' };

const TERMINAL: Readonly<Record<string, PlanPushDropReason>> = Object.freeze({
  duplicate: 'duplicate',
  no_devices: 'no_devices',
  suppressed_no_access: 'no_access',
});

/**
 * Writes what an attempt came to onto the marker.
 *
 * Only while the marker is still this attempt's (`in_flight`, same count): a
 * recorder that arrives after its lease ran out and another attempt was
 * claimed must not overwrite that attempt's lease.
 *
 * `quietEnd` is read by the caller outside the transaction, because it lives
 * in the routine profile and a transaction body must not do side reads it
 * does not need to be atomic with.
 */
export async function recordPlanPushOutcome(
  uid: string,
  date: string,
  attempt: number,
  result: PlanPushAttemptResult,
  now: Date,
  storage: StorageAdapter,
  quietEnd: string | null = null,
): Promise<PlanPushRecord> {
  const path = planPath(uid, date);
  return storage.runTransaction<PlanPushRecord>(async (tx) => {
    const stored = await tx.get<StoredDailyPlan>(path);
    const pending = stored ? readablePending(stored.pushPending) : null;
    if (!stored || !pending || pending.reason !== 'in_flight' || pending.attempts !== attempt) {
      return { kind: 'superseded' };
    }
    const clear = (record: PlanPushRecord): PlanPushRecord => {
      tx.set<StoredDailyPlan>(path, withoutPushPending(stored));
      return record;
    };
    const reschedule = (next: PlanPushPending): PlanPushRecord => {
      if (pending.attempts >= MAX_PLAN_PUSH_ATTEMPTS) return clear({ kind: 'dropped', reason: 'exhausted' });
      // Dropped now rather than at the claim, so a marker that can only ever
      // be dropped does not sit in the sweep's index until then.
      if (isPastMorningCutoff(stored.date, stored.timezone, new Date(next.nextAttemptAt))) {
        return clear({ kind: 'dropped', reason: 'stale' });
      }
      tx.set<StoredDailyPlan>(path, { ...stored, pushPending: next });
      return { kind: 'rescheduled', at: next.nextAttemptAt };
    };

    if (result.kind === 'threw') {
      return reschedule({
        attempts: pending.attempts,
        failedSends: pending.failedSends + 1,
        nextAttemptAt: iso(now.getTime() + PLAN_PUSH_RETRY_DELAY_MS),
        reason: 'send_failed',
      });
    }
    const status = result.status;
    if (status === null || status === 'sent') return clear({ kind: 'delivered' });
    if (status === 'suppressed_quiet_hours') {
      return reschedule({
        attempts: pending.attempts,
        failedSends: pending.failedSends,
        nextAttemptAt: quietEnd ?? iso(now.getTime() + PLAN_PUSH_RETRY_DELAY_MS),
        reason: 'quiet_hours',
      });
    }
    return clear({ kind: 'dropped', reason: TERMINAL[status] ?? 'refused' });
  });
}

/**
 * When this account's quiet hours next end, or null when that cannot be said.
 *
 * `nextDeliveryAt` is "the first instant after `now` at which the clock in
 * this zone reads HH:mm", DST gaps and folds answered; with the window's end as
 * the time, from inside the window, that instant is the window's end.
 */
async function quietHoursEnd(uid: string, now: Date, storage: StorageAdapter): Promise<string | null> {
  try {
    const quietHours = await readQuietHours(uid, { storage });
    if (!quietHours.window) return null;
    return nextDeliveryAt(now.toISOString(), { deliveryLocalTime: quietHours.window.end, timezone: quietHours.timezone });
  } catch {
    return null;
  }
}

export interface PlanPushAttempt {
  readonly uid: string;
  readonly date: string;
  readonly attempt: number;
  readonly dedupeKey: string;
  readonly locale: UserLocale;
}

/**
 * Sends one claimed attempt and records what it came to. True when the push
 * layer reports it delivered, or reports nothing.
 *
 * Never throws for the push: a throwing sender is the case this module exists
 * for. A failure to *record* is logged and swallowed too — the marker is then
 * still `in_flight`, its lease runs out, and the next attempt reuses this
 * attempt's key, so a send that did go out answers `duplicate`.
 */
export async function deliverPlanPush(
  attempt: PlanPushAttempt,
  sender: PlanPushSender,
  now: Date,
  storage: StorageAdapter,
): Promise<{ pushed: boolean; record: PlanPushRecord | null }> {
  let result: PlanPushAttemptResult;
  try {
    const outcome = await sender({
      uid: attempt.uid,
      kind: 'plan_ready',
      dedupeKey: attempt.dedupeKey,
      data: { planDate: attempt.date },
      respectQuietHours: true,
      urgency: 'normal',
      locale: attempt.locale,
    });
    result = { kind: 'reported', status: outcome ? outcome.status : null };
  } catch (error) {
    // No uid, as with every other line this job logs.
    console.error('[internal/jobs/daily-plan] push_failed', error instanceof Error ? error.name : 'unknown');
    result = { kind: 'threw' };
  }
  const pushed = result.kind === 'reported' && (result.status === null || result.status === 'sent');

  let record: PlanPushRecord | null = null;
  try {
    const quietEnd = result.kind === 'reported' && result.status === 'suppressed_quiet_hours'
      ? await quietHoursEnd(attempt.uid, now, storage)
      : null;
    record = await recordPlanPushOutcome(attempt.uid, attempt.date, attempt.attempt, result, now, storage, quietEnd);
  } catch (error) {
    console.error('[internal/jobs/daily-plan] push_outcome_unrecorded', error instanceof Error ? error.name : 'unknown');
  }
  if (record?.kind === 'dropped') logDrop(record.reason);
  return { pushed, record };
}

function logDrop(reason: PlanPushDropReason): void {
  // The reason and nothing else: no uid, no date, no plan content.
  console.warn('[internal/jobs/daily-plan] plan_push_dropped', reason);
}

/** `users/{uid}/plans/{date}` → its parts, or null for any other shape. */
export function planRefOfPath(path: string): { uid: string; date: string } | null {
  const parts = path.split('/');
  if (parts.length !== 4 || parts[0] !== 'users' || parts[2] !== PLANS) return null;
  try {
    return { uid: requireUserId(parts[1]), date: parts[3]! };
  } catch {
    return null;
  }
}

/**
 * Every plan whose pending push may be taken now, across accounts.
 *
 * A collection-group range read on the marker's own instant, so an ordinary
 * minute reads nothing. A plan without a marker has no `pushPending` field and
 * is in no index a query on it can return — the reason a cleared marker is
 * removed rather than nulled.
 */
export async function listDuePlanPushes(
  now: Date,
  storage: StorageAdapter,
  limit = PLAN_PUSH_RETRY_BATCH,
): Promise<Array<{ uid: string; date: string }>> {
  const rows = await storage.listGroup<StoredDailyPlan>(PLANS, {
    where: [['pushPending.nextAttemptAt', '<=', now.toISOString()]],
    orderBy: { field: 'pushPending.nextAttemptAt', direction: 'asc' },
    limit,
  });
  return rows.flatMap((row) => {
    const ref = planRefOfPath(row.path);
    return ref ? [ref] : [];
  });
}

export interface PlanPushRetryTotals {
  /** Retry attempts this sweep claimed and sent. */
  retried: number;
  /** Of those, the ones the push layer delivered. */
  retryPushed: number;
  /** Pending pushes this sweep gave up (stale, exhausted, opened, …). */
  retryDropped: number;
  failed: number;
}

/**
 * The push-only half of the sweep. Rebuilds nothing: it claims, sends the
 * stored plan's notice, and records.
 */
export async function runPlanPushRetries(
  now: Date,
  sender: PlanPushSender,
  storage: StorageAdapter,
  limit = PLAN_PUSH_RETRY_BATCH,
): Promise<PlanPushRetryTotals> {
  const totals: PlanPushRetryTotals = { retried: 0, retryPushed: 0, retryDropped: 0, failed: 0 };
  for (const { uid, date } of await listDuePlanPushes(now, storage, limit)) {
    try {
      const claim = await claimPlanPushRetry(uid, date, now, storage);
      if (claim.kind === 'not_due') continue;
      if (claim.kind === 'dropped') {
        totals.retryDropped += 1;
        logDrop(claim.reason);
        continue;
      }
      totals.retried += 1;
      const { pushed, record } = await deliverPlanPush(
        { uid, date, attempt: claim.attempt, dedupeKey: claim.dedupeKey, locale: claim.locale },
        sender,
        now,
        storage,
      );
      if (pushed) totals.retryPushed += 1;
      if (record?.kind === 'dropped') totals.retryDropped += 1;
    } catch (error) {
      totals.failed += 1;
      console.error('[internal/jobs/daily-plan] one pending push failed', error instanceof Error ? error.name : 'unknown');
    }
  }
  return totals;
}
