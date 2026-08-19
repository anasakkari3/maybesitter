/**
 * The public surface of the planning constraint model (Sprint 07, issue #29).
 *
 * Two things, and the line between them is the sprint's central rule. The
 * *normalizer* is arithmetic — a wall-clock window materialised against real
 * dates — and the design lets #30's scheduler and #31's oracle import it,
 * because a second copy of that conversion is the Sprint 06 gap rather than a
 * Sprint 06 check. The *validator* is a judgement, and neither may import it:
 * #31's oracle derives the same static verdict independently, and the
 * merge-owned cross-track test compares the two. An import would make that
 * comparison compare a thing with itself.
 *
 * ## What "end times are exclusive" means here
 *
 * Every interval this module produces or consumes is half-open,
 * `[startsAt, endsAt)`, per rule 1 of `planningContracts`. Three consequences
 * are load-bearing and each is pinned by a test:
 *
 *  - A working window's `endMinute` is exclusive, so `09:00-17:00` is
 *    `{ startMinute: 540, endMinute: 1020 }` and does not include 17:00. The
 *    domain runs to 1440 so that "until midnight" is one window rather than a
 *    window plus a special case.
 *  - A fixed event abutting a working window removes nothing from it, and two
 *    back-to-back blocking events are not a `FIXED_EVENT_CONFLICT`. Every
 *    comparison goes through the shared `intervalsOverlap`, so this means the
 *    same thing here as in #30 and #31.
 *  - A deadline lying exactly on the horizon's `endsAt` is *inside* the
 *    horizon, and an occurrence starting exactly at `endsAt` is outside it.
 *
 * ## What "unknown duration is handled explicitly" means here
 *
 * `Effort` is a variant, and the validator destructures it. An `unknown` effort
 * produces `EFFORT_UNKNOWN` and suppresses `EFFORT_EXCEEDS_ITEM_WINDOW`, which
 * has no size to compare against. Nothing in this module estimates, defaults, or
 * substitutes a duration: a plan built on a guessed duration looks feasible and
 * is not, and nothing downstream can tell the difference.
 *
 * ## Migration and rollback
 *
 * **Migration: none required.** This module is additive and pure. It adds
 * source files under `lib/planning/constraints/` and tests under
 * `tests/planning/`, all of which `package.json` already registered on the
 * sprint base. It defines no schema, writes no row, reads no file, opens no
 * route, and changes no existing module's behaviour — nothing imports it yet
 * except its own tests. There is no data to backfill because there is no data:
 * `PLANNING_PERSISTENCE_POLICY.planCanPersist` is false, and this module is
 * upstream even of a plan.
 *
 * **Rollback: delete the files, or revert the commit.** Because nothing
 * persists and nothing else imports it, reverting leaves no orphaned state, no
 * half-migrated rows and no version skew — the condition that usually makes a
 * rollback harder than the change. The one coupling to check on a revert is the
 * *forward* direction: #30 and #31 are permitted to import `normalizeWorkingWindows`
 * and `freeRunsWithin`, so a revert that lands after either of those tracks must
 * revert them too, or their imports dangle. `tests/planning/constraintsBoundaries.test.ts`
 * pins the reverse direction — this module imports neither sibling — so the
 * dependency can only ever run one way and a revert only ever has one direction
 * to look in.
 *
 * **Forward compatibility.** The exported shapes are additive over the frozen
 * contract, not a second copy of it: `MaterializedWindow` and `WindowAnomaly`
 * describe intermediate results, and every code this module emits comes from
 * `STATIC_INFEASIBILITY_CODES`. A future code added to the contract fails
 * `constraintsValidator.test.ts`'s coverage sweep rather than silently going
 * unreported by one of the two tracks that must agree on it.
 */

export {
  freeRunsWithin,
  mergeIntervals,
  normalizeWorkingWindows,
  type BoundaryResolutionKind,
  type MaterializedWindow,
  type NormalizedWindows,
  type WindowAnomaly,
} from './normalize';

export {
  validateConstraints,
  type ConstraintValidationOptions,
} from './validator';
