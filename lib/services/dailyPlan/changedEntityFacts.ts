/**
 * Each pending change's post-change facts, resolved from canonical stored
 * state (#605).
 *
 * The impact evaluator can only return `REPLAN_REQUIRED` when it knows where
 * the changed entity now sits and whether that time is blocked (rule 6). A
 * `PlanningStateChange` deliberately carries neither: it is a content-free
 * notice that an entity moved. So the facts are read here, from the entity as
 * it is stored now, one change at a time.
 *
 * ── Why per change, and why a map ─────────────────────────────────
 *
 * The pipeline used to take a single `entityFacts` for the whole batch. The
 * only way to fill it from storage would have been to resolve one entity and
 * apply its facts to every change beside it. A monitor firing that shared a
 * tick with a real meeting would then be judged as the meeting, earn
 * `REPLAN_REQUIRED`, and be named as a cause on the Trust surface (#527). A
 * map keyed by `changeId` cannot express that mistake.
 *
 * ── What resolves, and what does not ───────────────────────────────
 *
 * `calendar`: the busy block whose `blockId` is the change's `entityId`, read
 * from this account's own store. Its interval is the block's. Whether it
 * blocks is decided by `toFixedEvents`, the rule the planner itself applies, so
 * an all-day entry that the solver ignores cannot earn a replan here either.
 * No block means the entity occupies no time any more: `{ interval: null,
 * blocking: false }`, which the contract defines as a cancellation or
 * deletion. It frees capacity (`PLAN_STALE`) and never contradicts a placement.
 * When the row carries the block's interval from before the change
 * (`beforeInterval`, which the busy-block producer writes, #611), it comes
 * back as `previousInterval`, so a removal outside the plan's horizon is
 * `NO_EFFECT` instead of freeing time on a day it was never on.
 * Two blocks with one id (two sources choosing the same id) resolve to null,
 * because there is no honest way to pick one.
 *
 * Every other source resolves to null, as `ChangedEntityFacts` specifies for
 * sources whose effect is not a span of time (readiness, habit policy, a
 * watcher firing). `commitment`, `external_task` and `manual` are judged on
 * their digests and fields too. None has a canonical "busy interval" to read,
 * and inventing one here would be deciding planner semantics in a lookup.
 *
 * Scope: a change is resolved only against the account running the tick, and
 * only when it names that account. A row naming another scope resolves to
 * null and is then refused by the evaluator's own scope rule. The lookup never
 * reads another account's store.
 *
 * Only an interval and a boolean leave this module. No source id, source kind,
 * title or other provider value reaches the planning contracts.
 *
 * ── Who writes the rows ───────────────────────────────────────────
 *
 * `calendar` rows come from `lib/calendar/busyBlocks.ts` (#611): every
 * busy-block write — the phone's sync, an ICS feed, accepted lecture sessions,
 * a disconnect — commits each block it adds, moves or removes together with
 * its row, so a row is never visible before its block is in the state it
 * announces. A moved meeting is two rows, because a block's id hashes its
 * start: the old id, which resolves as deleted here, and the new id, which
 * resolves to its new interval. `watcher` rows come from `watcherEngine` and
 * resolve to null, as above.
 */
import type { StorageAdapter } from '../../storage';
import { readBusyBlocksById, toFixedEvents, type BusyBlock } from '../../calendar/busyBlocks';
import type { ChangedEntityFacts } from '../../../src/contracts/v1/replanContracts';
import type { TimeInterval } from '../../../src/contracts/v1/planningContracts';
import type { PlanningStateChange } from '../../../src/contracts/v1/watcherContracts';

/** Each change's own facts, keyed by `changeId`. An absent key means null. */
export type EntityFactsByChangeId = ReadonlyMap<string, ChangedEntityFacts | null>;

/** What a stored busy block now tells the planner, or what its absence tells it. */
export function factsOfBusyBlock(block: BusyBlock | null): ChangedEntityFacts {
  if (block === null) return Object.freeze({ interval: null, blocking: false });
  const asPlanned = toFixedEvents([block]);
  return Object.freeze({
    interval: Object.freeze({ startsAt: block.startAt, endsAt: block.endAt }),
    blocking: asPlanned.length === 1 && asPlanned[0]!.blocking,
  });
}

/**
 * What resolution reads of a change: which account, which source, which entity.
 * A stored proposal's `causeRefs` carry exactly this, so the causes of an offer
 * can be re-resolved after their change rows were drained (#611 guards).
 */
export type EntityRef = Pick<PlanningStateChange, 'changeId' | 'scopeId' | 'source' | 'entityId' | 'beforeInterval'>;

/**
 * The change's own record of where the entity sat before it (#611), if it
 * carries a well-formed one. The block itself cannot say: after a removal it
 * is gone. Anything malformed is dropped, which leaves the span unknown and
 * the change judged as before, never ruled outside a horizon.
 */
function previousIntervalOf(change: EntityRef): TimeInterval | null {
  const before = change.beforeInterval;
  if (!before || typeof before.startsAt !== 'string' || typeof before.endsAt !== 'string') return null;
  const [start, end] = [Date.parse(before.startsAt), Date.parse(before.endsAt)];
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Object.freeze({ startsAt: before.startsAt, endsAt: before.endsAt });
}

export async function resolveChangedEntityFacts(
  uid: string,
  changes: readonly EntityRef[],
  deps: { readonly storage: StorageAdapter },
): Promise<EntityFactsByChangeId> {
  const own = (change: EntityRef) => change.scopeId === uid;
  const calendarIds = changes.filter((change) => own(change) && change.source === 'calendar').map((change) => change.entityId);
  const blocks = calendarIds.length > 0
    ? await readBusyBlocksById(uid, calendarIds, { storage: deps.storage })
    : new Map<string, readonly BusyBlock[]>();

  const facts = new Map<string, ChangedEntityFacts | null>();
  for (const change of changes) {
    if (!own(change) || change.source !== 'calendar') {
      facts.set(change.changeId, null);
      continue;
    }
    const matches = blocks.get(change.entityId) ?? [];
    if (matches.length > 1) {
      facts.set(change.changeId, null);
      continue;
    }
    const now = factsOfBusyBlock(matches[0] ?? null);
    const previousInterval = previousIntervalOf(change);
    facts.set(change.changeId, previousInterval === null ? now : Object.freeze({ ...now, previousInterval }));
  }
  return facts;
}
