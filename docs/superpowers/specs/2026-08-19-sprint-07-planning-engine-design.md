# Sprint 07 — Planning Engine, design

Issues: [#29](https://github.com/anasakkari3/maybesitter/issues/29) (availability and
constraint model), [#30](https://github.com/anasakkari3/maybesitter/issues/30)
(deterministic scheduler v1), [#31](https://github.com/anasakkari3/maybesitter/issues/31)
(scenarios and feasibility oracle).

Base: `bbb40ec` (`main` after Sprint 06).

## What the sprint builds

A planner that takes commitments with deadlines, effort, dependencies and buffers, plus
the windows a user is willing to work in and the events already fixed in their calendar,
and returns a *plan*: which items go where, and for every item that goes nowhere, why.

A plan is a proposal about time. It is never canonical user state — same boundary Capture
set in Sprint 01 and Decomposition re-applied in Sprint 06. See
`PLANNING_PERSISTENCE_POLICY`.

## The dependency the issue text does not mention

The three issues are labelled independent and their file trees are disjoint, but all three
implement judgements over one vocabulary: *why can this not be planned*. #29's validator
decides it from the constraints, #30's scheduler decides it by trying, #31's oracle decides
it a third time as a check.

The roadmap already records what happens when that goes unmanaged, twice:

> Sprint 02 — "Writing the shared contracts before starting parallel work prevented merge
> conflicts, but did not prevent the three modules from *interpreting* the contract three
> different ways: 91 tests passed while they disagreed."

> Sprint 06 — "Two independent implementations of a *judgement* are a check on each other.
> Two independent copies of *data* are a gap waiting for whichever caller falls into it."

So this sprint resolves the dependency before the parallel work starts, rather than at merge:

1. **`src/contracts/v1/planningContracts.ts` is written first**, on the sprint base, and no
   track edits it. It carries the reason taxonomy, and the taxonomy is *partitioned* into
   `STATIC_INFEASIBILITY_CODES` (decidable from constraints alone — #29 and #31 must agree
   on these) and `ATTEMPT_INFEASIBILITY_CODES` (only true after placement was tried — #30
   alone emits these). The partition is exported as frozen data, not just as a type, because
   the cross-track comparison has to filter by it at runtime.

2. **`lib/planning/shared/time.ts` is written first** and all three tracks import it. It owns
   every instant/wall-clock conversion, the half-open overlap rule, and DST resolution. This
   is the Sprint 06 lesson applied pre-emptively: three readings of "what time is 02:30 on
   the spring-forward date" is not three checks, it is three chances to be wrong alone.

3. **The sprint ends with a merge-owned cross-track test** that runs #31's scenarios against
   #30's real scheduler and compares #29's validator to #31's oracle on identical inputs.
   Per Sprint 05's rule, it is owned by the merge: a check owned by the thing it checks is
   not a check.

## Decisions worth stating once

**Half-open intervals, everywhere.** `[startsAt, endsAt)`; the end instant is excluded, so
back-to-back work does not conflict. Issue #29's "end times are exclusive and documented"
criterion is satisfied by the type and its one shared overlap function, not by each track's
prose.

The textbook overlap formula is wrong for a zero-length interval — it reports `[09:00, 09:00)`
as overlapping `[08:00, 10:00)` — so `intervalsOverlap` guards emptiness and returns the
honest answer. Well-formedness is a separate question, answered once by `INVALID_INTERVAL`
before anything is scheduled.

**Unknown effort is a variant, not a sentinel.** `Effort` is `{kind:'known', minutes}` or
`{kind:'unknown'}`. A duration of `0` or `null` reads as a number to arithmetic, and a plan
that placed a zero-length task would satisfy every overlap check while telling the user
nothing. `EFFORT_UNKNOWN` is reported; it is never guessed.

**Wall-clock and absolute are different types.** A working window is a rule about a clock
face in a named zone (`weekday` + `startMinute` + `endMinute` + `timezone`). A fixed event is
a thing that happens at an instant. They are only the same on the 363 days a year the offset
does not move. `LocalTimeResolution` makes the other two expressible: a local time may denote
no instant (`gap`, spring forward) or two (`fold`, fall back).

**Determinism is contract-level.** `PLAN_ORDERING_KEYS` states the total order — `startsAt`,
then `-priority`, then `earliestDeadline`, then `itemId`. The last key is unique, so map
iteration order, input array order and sort stability cannot leak into a plan. `Plan.inputDigest`
hashes the canonical serialisation of constraints plus config, which is what makes "replay
produced the same plan" an assertion rather than a claim.

**No ambient clock.** Nothing under `lib/planning/` may call `Date.now()`, `new Date()` with
no argument, `Math.random()` or `randomUUID()`. Every instant comes from the input. A planner
that could read a clock produces a different plan on every run and no determinism test would
catch it. Enforced structurally by `tests/planning/planningBoundaries.test.ts`.

## Track layout

Disjoint by construction. `package.json` already registers every test file below, on the
base, so no track edits it and there is no merge conflict there.

| Track | Owns | Tests |
|---|---|---|
| #29 | `lib/planning/constraints/` | `constraintsNormalize`, `constraintsValidator`, `constraintsDst`, `constraintsBoundaries` |
| #30 | `lib/planning/scheduler/` | `schedulerPlacement`, `schedulerDeterminism`, `schedulerReasons`, `schedulerDiff`, `schedulerBoundaries` |
| #31 | `lib/planning/evaluation/` | `oracleFeasibility`, `scenarioCorpus`, `scenarioLockPolicy`, `planMetrics` |
| base / merge | `src/contracts/v1/planningContracts.ts`, `lib/planning/shared/` | `sharedTime`, `planningCrossTrack`, `planningBoundaries` |

**Permitted cross-track imports.** #30 and #31 may import #29's normalizer, because
materialising a wall-clock window against real dates is *arithmetic*, and a second copy of it
is the Sprint 06 gap rather than a Sprint 06 check. Neither may import #29's **validator**,
and #31's **oracle** must not import #30's scheduler — those are the judgements the
cross-track test compares, and an import would make it compare a thing with itself.

`src/contracts/v1/moduleContracts.ts` — the `planning` descriptor moves from placeholder to
`implemented` — is edited by **#30 only**, together with the assertion that pins it at
`tests/contract/intelligenceModuleBoundaries.test.ts:78`.

## Scope boundaries

Not in this sprint: persistence of plans, an API route, UI, calendar write-back, re-planning
policy, and any use of a model. v1 is deterministic and offline. `resource` and
`informational` dependencies are recorded but do not force ordering
(`PlanningConfig.resourceDependenciesOrder` is false in v1).

## Migration and rollback

Additive only. New files under `lib/planning/` and `tests/planning/`, one new contract file,
and one descriptor flip in `moduleContracts.ts`. No schema, no stored data, no route, no
existing module's behaviour. Rollback is `git revert` of the sprint merge; nothing persists
across it because planning writes nothing.
