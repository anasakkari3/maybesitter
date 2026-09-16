/**
 * Domain events → what a person is shown they did (UC-3.15, #201).
 *
 * ── An allowlist, and why it has to be one ───────────────────────
 *
 * The event log is the whole domain's log. It carries pressure deliveries,
 * escalation levels, classification changes and every internal transition the
 * state machine makes. Most of those are things the system decided *about*
 * someone, and #201's activity screen is a record of what they did — so the
 * map below names the event types that become a user-visible entry, and
 * anything absent is excluded by falling off the end.
 *
 * Written as a denylist it would be correct exactly until the next domain
 * event is added, and the failure mode is silent: a new
 * `pressure_escalation_scheduled` would simply start appearing in somebody's
 * history with no code change and no test going red.
 * `tests/activity/activityProjection.test.ts` asserts the map against the
 * event types `src/domain/stateMachine.ts` actually emits, so adding one there
 * fails until it is either mapped or listed as deliberately not user-facing.
 *
 * ── Where the last two kinds come from ───────────────────────────
 *
 * `plan_accepted` is produced by UC-3.10a (#194), which keeps it in its own
 * ledger (`users/{uid}/planEvents`) rather than in this log. activityService
 * merges that ledger in, through planActivity's own allowlist, and hands the
 * accepted entries to this projection shaped as records — so it is mapped
 * here once, whichever collection it was read from.
 *
 * `reminder_acknowledged` (UC-3.14, #200) still has no producer. It is in the
 * contract because the client, the schema and the copy are built around the
 * full set, so that #200 lands additively rather than moving the shape under
 * a shipped client. Nothing fabricates it: no account sees that kind today.
 *
 * ── `commitment_aware` is deliberately not here ──────────────────
 *
 * «لسّا» marks awareness of a commitment; #200's `reminder_acknowledged` is
 * the tap on a soft reminder. They are not the same event, and giving the one
 * that exists today the other's kind would put a number under the wrong label
 * and make #200 a breaking change instead of an additive one.
 *
 * ── Titles are read at read time ─────────────────────────────────
 *
 * Not copied into the entry when the event was written. A commitment renamed
 * after it was completed should read as its current name, and one deleted
 * afterwards has no name to show — so the entry carries a null title and the
 * client says "a removed item" in the user's own language. A title frozen into
 * the log would also be a second copy of the most personal string this product
 * holds, in a collection that is never edited.
 */
import type { DomainEventRecord } from '../mobile/eventLog';

export type ActivityKind =
  | 'captured'
  | 'confirmed'
  | 'completed'
  | 'postponed'
  | 'dropped'
  | 'plan_accepted'
  | 'reminder_acknowledged';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  at: string;
  commitmentId: string | null;
  /** Null when the commitment is gone; the client names that, not this. */
  commitmentTitle: string | null;
  detail?: { postponedUntil?: string; planDate?: string };
}

/**
 * The only event types that become activity. Order is documentation, not
 * behaviour.
 */
export const ACTIVITY_KIND_BY_EVENT_TYPE: Readonly<Record<string, ActivityKind>> = Object.freeze({
  draft_created: 'captured',
  commitment_activated: 'confirmed',
  commitment_completed: 'completed',
  commitment_postponed: 'postponed',
  commitment_dropped: 'dropped',
  // Read from the plan ledger (#194) — see the header.
  plan_accepted: 'plan_accepted',
  // No producer in this repository yet (#200) — see the header.
  reminder_acknowledged: 'reminder_acknowledged',
});

/** The kinds an account can actually be shown today. */
export const PRODUCED_ACTIVITY_KINDS: readonly ActivityKind[] = Object.freeze([
  'captured', 'confirmed', 'completed', 'postponed', 'dropped', 'plan_accepted',
]);

const PLAN_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface CommitmentTitleSource {
  title: string;
}

/**
 * The commitment an event is about.
 *
 * Most events are stamped with the commitment as their aggregate. The two
 * reminder events are stamped with the *reminder*, and carry the commitment in
 * their payload — so reading `aggregateId` alone would attribute #200's
 * acknowledgement to an id no commitment has.
 */
export function commitmentIdOf(event: DomainEventRecord): string | null {
  const fromPayload = event.payload?.commitmentId;
  if (typeof fromPayload === 'string' && fromPayload !== '') return fromPayload;
  return typeof event.aggregateId === 'string' && event.aggregateId !== '' ? event.aggregateId : null;
}

export function projectActivity(
  events: readonly DomainEventRecord[],
  commitmentsById: ReadonlyMap<string, CommitmentTitleSource>,
): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const event of events) {
    const kind = ACTIVITY_KIND_BY_EVENT_TYPE[event.type];
    if (!kind) continue;
    const commitmentId = commitmentIdOf(event);
    const item: ActivityItem = {
      id: event.id,
      kind,
      at: event.at,
      commitmentId,
      commitmentTitle: commitmentId ? commitmentsById.get(commitmentId)?.title ?? null : null,
    };
    const postponedUntil = event.payload?.postponedUntil;
    if (kind === 'postponed' && typeof postponedUntil === 'string') {
      item.detail = { postponedUntil };
    }
    const planDate = event.payload?.planDate;
    if (kind === 'plan_accepted' && typeof planDate === 'string' && PLAN_DATE.test(planDate)) {
      item.detail = { planDate };
    }
    items.push(item);
  }
  return items;
}
