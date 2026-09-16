/**
 * Tell the user when a new commitment lands on top of one they already have.
 *
 * This is the fourth and last piece of the owner's own request for the
 * football-fixtures feature: know about the match, do not place work there,
 * put it on the calendar, and -- the one this module is -- warn if he books a
 * collision anyway. It **warns, it does not refuse**. The user is allowed to
 * book over Saturday's match; they are not allowed to do it without being
 * told, so `findCollisions` is a pure query a route consults and reports
 * alongside a write it still performs.
 *
 * ── Why `fixedEndFor` lives here now ────────────────────────────────
 *
 * Task 1 (`buildDailyPlan.ts`) had its own private answer to "how long does a
 * pinned commitment occupy": its own end time when it names one and that end
 * is strictly after the start, otherwise `DEFAULT_FIXED_EVENT_MINUTES`. This
 * module needs the exact same answer for exactly the same reason -- a
 * candidate with no stated end still occupies real time and still has to be
 * checked against it -- and a second, textually-identical implementation is
 * how the planner and the device calendar came to disagree with each other in
 * the first place (that disagreement was this branch's first commit). So the
 * rule is written once, here, and `buildDailyPlan.ts` imports it rather than
 * keeping its own copy.
 *
 * `DEFAULT_FIXED_EVENT_MINUTES` still comes *from* `buildDailyPlan.ts`: it is
 * that module's stated invented number (its own doc comment says so), and
 * this module borrows it rather than inventing a second one. The two modules
 * import from each other -- `buildDailyPlan.ts` imports `fixedEndFor` from
 * here, this module imports the constant from there -- which is safe under
 * ES module live bindings because neither side reads the other's export at
 * module-evaluation time, only from inside a function body called after the
 * whole graph has loaded.
 */
import { intervalsOverlap } from '../planning/shared/time';
import type { Instant, TimeInterval } from '../../src/contracts/v1/planningContracts';
import type { Commitment } from '../../src/domain/stateMachine';
import { DEFAULT_FIXED_EVENT_MINUTES } from './dailyPlan/buildDailyPlan';

const MS_PER_MINUTE = 60_000;

/**
 * The bare shape of "a warning worth showing": what was collided with, and
 * when it happens. No `origin` field -- an earlier task carried one and it
 * was withdrawn, because a sealed annotation corpus checksums the whole
 * serialised commitment and the field moved it. A caller that needs to know a
 * colliding commitment came from a synced feed joins the external task
 * references for that, which is where provenance already lives; it is not
 * this module's job to repeat it.
 */
export interface CollisionWarning {
  readonly commitmentId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

/**
 * Only an open, still-active commitment is a claim on anybody's time. A
 * completed or dropped commitment already gave its slot back; colliding with
 * one would be a warning about a clash that no longer exists.
 */
const COLLIDABLE_STATUSES: ReadonlySet<Commitment['status']> = new Set<Commitment['status']>(['active', 'deferred']);

/**
 * How long an interval that starts at `start` and names `endAt` (or names
 * none) actually occupies.
 *
 * `endAt` when it is given and strictly after `start` -- the same half-open
 * rule the domain validates on write. Anything else falls back to
 * `DEFAULT_FIXED_EVENT_MINUTES`: a zero-length or inverted interval would be
 * a blocking event that `intervalsOverlap` reports as intersecting nothing,
 * which is a "collision" that silently collides with nothing.
 *
 * Shared by `fixedEndFor` (an existing commitment's own duration) and
 * `findCollisions` (the candidate's duration), so the two cannot compute two
 * different answers for the same rule.
 */
function intervalEndFor(start: Instant, endAt: string | null): Instant {
  if (endAt) {
    const end = Date.parse(endAt);
    if (Number.isFinite(end) && end > Date.parse(start)) return new Date(end).toISOString();
  }
  return new Date(Date.parse(start) + DEFAULT_FIXED_EVENT_MINUTES * MS_PER_MINUTE).toISOString();
}

/**
 * How long a pinned commitment occupies. Moved here from `buildDailyPlan.ts`
 * (Task 1); see the module doc for why. Behaviour is unchanged -- this is the
 * same rule under the same name, just with one home instead of two.
 */
export function fixedEndFor(commitment: Commitment, start: Instant): Instant {
  return intervalEndFor(start, commitment.timeSpec.endAt);
}

/**
 * Which existing commitments a candidate write would land on top of.
 *
 * `against` is filtered to `scheduled_event` commitments in an open status
 * (`isCollidable`) before anything is compared: a `due_by` or `unscheduled`
 * commitment names no interval to collide with, and a `completed` or
 * `dropped` one is not a claim on the calendar any more.
 *
 * The comparison itself is `intervalsOverlap` -- half-open `[start, end)`,
 * reused rather than reimplemented so this can never disagree with the
 * planner or `mobile/src/features/calendarDemo/overlap.ts` about what
 * "overlap" means. Back-to-back (one ends exactly as the other starts) is
 * not a clash: a warning that fires there is a warning people learn to
 * dismiss without reading.
 */
export function findCollisions(
  candidate: { readonly dueAt: string; readonly endAt: string | null },
  against: readonly Commitment[],
): readonly CollisionWarning[] {
  const candidateInterval: TimeInterval = {
    startsAt: candidate.dueAt,
    endsAt: intervalEndFor(candidate.dueAt, candidate.endAt),
  };

  return against
    .filter((commitment) => COLLIDABLE_STATUSES.has(commitment.status) && commitment.timeSpec.kind === 'scheduled_event')
    .flatMap((commitment): CollisionWarning[] => {
      const start = commitment.timeSpec.dueAt;
      if (!start) return [];
      const interval: TimeInterval = { startsAt: start, endsAt: fixedEndFor(commitment, start) };
      if (!intervalsOverlap(candidateInterval, interval)) return [];
      return [{
        commitmentId: commitment.id,
        title: commitment.title,
        startsAt: interval.startsAt,
        endsAt: interval.endsAt,
      }];
    });
}
