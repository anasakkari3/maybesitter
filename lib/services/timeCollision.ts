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
 * ── Why `fixedEndFor` and `DEFAULT_FIXED_EVENT_MINUTES` live here now ─
 *
 * Task 1 (`buildDailyPlan.ts`) had its own private answer to "how long does a
 * pinned commitment occupy": its own end time when it names one and that end
 * is strictly after the start, otherwise a default number of minutes. This
 * module needs the exact same answer for exactly the same reason -- a
 * candidate with no stated end still occupies real time and still has to be
 * checked against it -- and a second, textually-identical implementation is
 * how the planner and the device calendar came to disagree with each other in
 * the first place (that disagreement was this branch's first commit). So the
 * rule, and the number it depends on, are both written once, here, and
 * `buildDailyPlan.ts` imports them rather than keeping its own copies.
 *
 * The dependency runs one way only: `buildDailyPlan.ts` imports from this
 * module, never the reverse. An earlier version of this had it borrowing
 * `DEFAULT_FIXED_EVENT_MINUTES` back from `buildDailyPlan.ts`, which worked
 * (ES module live bindings make it work, as long as nothing touches the
 * cycle at module-evaluation time) but was still a cycle -- and a cycle means
 * these two modules can never again be reasoned about, moved, or lazily
 * loaded independently, a property that holds only until somebody adds a
 * top-level use of the wrong export and nothing warns them. `buildDailyPlan.ts`
 * re-exports the constant for its own existing callers, so this move changed
 * no import path outside these two files.
 */
import { intervalsOverlap } from '../planning/shared/time';
import type { Instant, TimeInterval } from '../../src/contracts/v1/planningContracts';
import type { Commitment } from '../../src/domain/stateMachine';

const MS_PER_MINUTE = 60_000;

/**
 * How long a commitment with a fixed start, but no stated end, is assumed to
 * occupy. Owned here rather than by the planner: this module's subject is
 * exactly "how long does a commitment occupy", and `buildDailyPlan.ts` is a
 * consumer of that answer, not its source. `buildDailyPlan.ts` re-exports
 * this for its own existing callers.
 */
export const DEFAULT_FIXED_EVENT_MINUTES = 30;

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
 * Whether a commitment names a stretch of clock time a collision can be
 * measured against, and if so where it starts and what it says about its end.
 *
 * A commitment is *timed* when it has a `dueAt`, is not all-day, and is a
 * `scheduled_event` or a `due_by`. The `due_by` half is the point: everything
 * a user adds -- capture's extraction, an edit that moves a time, the legacy
 * create route -- writes `due_by`, never `scheduled_event` (only the football
 * projection writes that). Checking `scheduled_event` alone meant the warning
 * could never fire for a commitment the user added, which is the one case the
 * owner asked for. "Call the dentist at 8pm" occupies 8pm: it is measured from
 * `dueAt` for its `endAt`, or `DEFAULT_FIXED_EVENT_MINUTES` without one.
 *
 * This is about *warning*, not planning. The planner keeps its own rule for
 * which commitments block time (`buildDailyPlan.ts`), and a `due_by` item stays
 * a deadline there; nothing here turns a deadline into a blocking event.
 *
 * `unscheduled` and all-day commitments name no clock interval, so they
 * collide with nothing.
 */
export function collisionIntervalOf(
  commitment: Commitment,
): CollisionCandidate | null {
  const { kind, dueAt, endAt, allDay } = commitment.timeSpec;
  if (!dueAt || allDay) return null;
  if (kind !== 'scheduled_event' && kind !== 'due_by') return null;
  return { dueAt, endAt, kind };
}

/**
 * What `findCollisions` compares: an interval, and whether it is a fixed event.
 * `kind` left out means a fixed event -- a caller handing over a bare interval
 * (a projected match) is describing something that happens at that time.
 */
export interface CollisionCandidate {
  readonly dueAt: string;
  readonly endAt: string | null;
  readonly kind?: 'scheduled_event' | 'due_by';
}

/**
 * A clash needs a fixed event on at least one side.
 *
 * Capture writes `due_by` for "at 8pm" and "by 5pm" alike, so the domain
 * cannot tell an appointment from a deadline. Two deadlines due at the same
 * hour ("pay the rent by 5pm Friday", "submit the report by 5pm Friday") are
 * an ordinary Friday, and warning about them would reach every user, football
 * or not, with a warning the owner never asked for. A `due_by` over a
 * `scheduled_event` -- dinner at 20:00 during a 19:00 match, which is every
 * projected match -- still warns, which is the case that was asked for.
 */
function eitherIsFixed(a: CollisionCandidate['kind'], b: CollisionCandidate['kind']): boolean {
  return (a ?? 'scheduled_event') === 'scheduled_event' || (b ?? 'scheduled_event') === 'scheduled_event';
}

/**
 * The collisions for a commitment that already exists in `all` -- the capture
 * confirm, the edit route and the legacy create route all ask exactly this --
 * or none when it is not timed. It is never compared with itself.
 */
export function collisionsForCommitment(
  commitment: Commitment | undefined,
  all: readonly Commitment[],
): readonly CollisionWarning[] {
  if (!commitment) return [];
  const interval = collisionIntervalOf(commitment);
  if (!interval) return [];
  return findCollisions(interval, all.filter((candidate) => candidate.id !== commitment.id));
}

/**
 * Which existing commitments a candidate write would land on top of.
 *
 * `against` is filtered to timed commitments (`collisionIntervalOf`) in an
 * open status before anything is compared: an `unscheduled` or all-day
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
  candidate: CollisionCandidate,
  against: readonly Commitment[],
): readonly CollisionWarning[] {
  const candidateInterval: TimeInterval = {
    startsAt: candidate.dueAt,
    endsAt: intervalEndFor(candidate.dueAt, candidate.endAt),
  };

  return against
    .filter((commitment) => COLLIDABLE_STATUSES.has(commitment.status))
    .flatMap((commitment): CollisionWarning[] => {
      const timed = collisionIntervalOf(commitment);
      if (!timed || !eitherIsFixed(candidate.kind, timed.kind)) return [];
      const interval: TimeInterval = { startsAt: timed.dueAt, endsAt: fixedEndFor(commitment, timed.dueAt) };
      if (!intervalsOverlap(candidateInterval, interval)) return [];
      return [{
        commitmentId: commitment.id,
        title: commitment.title,
        startsAt: interval.startsAt,
        endsAt: interval.endsAt,
      }];
    });
}
