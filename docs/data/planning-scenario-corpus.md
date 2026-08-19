# Planning Scenario Corpus and Feasibility Oracle

Sprint 07, [issue #31](https://github.com/anasakkari3/maybesitter/issues/31).
Design: `docs/superpowers/specs/2026-08-19-sprint-07-planning-engine-design.md`.
Contracts: `src/contracts/v1/planningContracts.ts` (committed on the sprint base before this work
started, and not modified by it).

## 0. Status — every scenario is synthetic

**No planning scenario has been reviewed by a person.** `PlanningScenarioCorpus.provenance` is
`'synthetic'` and `tests/planning/scenarioCorpus.test.ts` asserts it rather than trusting it. The
same test refuses any `note` that claims review.

This is the position Sprint 04 took for `data/quality/priority-judgments.json` and Sprint 06 kept
for the decomposition seed corpus, for the same reason: a dataset that claims review it never had
corrupts every number computed from it afterwards, invisibly, because a score over fabricated
labels looks exactly like a score over real ones.

What that means in practice: **the corpus is evidence about the code, not about users.** A green
run says the oracle, the generator and the metrics agree with the contract and with each other. It
says nothing about whether these are the weeks real people actually have.

## 1. What is here

| Module | Purpose |
|---|---|
| `lib/planning/evaluation/oracle.ts` | `assessFeasibility(constraints, config)` — the static infeasibility codes, plus `availableMinutes` and `demandMinutes`. |
| `lib/planning/evaluation/scenarios.ts` | The curated corpus, the seeded generator, the assembly gate and the locked/tunable partition. |
| `lib/planning/evaluation/metrics.ts` | `computePlanQualityMetrics` over a `Plan` supplied as data. |
| `lib/planning/evaluation/index.ts` | The public surface. |

| Test | What it pins |
|---|---|
| `tests/planning/oracleFeasibility.test.ts` | Each static code, the capacity arithmetic, and the four DST instants. |
| `tests/planning/scenarioCorpus.test.ts` | Kind coverage as a refusal, id uniqueness, generator determinism, oracle agreement. |
| `tests/planning/scenarioLockPolicy.test.ts` | Locked rows cannot reach the tuning path, structurally. |
| `tests/planning/planMetrics.test.ts` | Every metric, including the three empty denominators. |

## 2. The oracle is a second reading, not a helper

`lib/planning/constraints/validator.ts` (#29) decides which `STATIC_INFEASIBILITY_CODES` apply from
the constraints alone. This oracle decides the same question a second time, and the sprint ends with
a merge-owned cross-track test that runs both on identical inputs and compares the sets.

**So this package imports neither #29's validator nor anything under `lib/planning/scheduler/`.** An
import would make that comparison compare a thing with itself, which is the trap the roadmap records
from Sprint 02 — "91 tests passed while they disagreed". `lib/planning/shared/time.ts` *is* imported,
because arithmetic is not a judgement and a second copy of it would be a gap rather than a check.

`lib/planning/constraints/normalize.ts` was permitted to this track by the design, and does not exist
on the sprint base this branch was cut from. Window materialisation is therefore implemented here
(`occurrencesOf` in `oracle.ts`). **This is the one place the sprint's "no second copy of arithmetic"
rule is not satisfied**, and it is the first thing to reconcile at merge: if #29's normalizer and this
materialisation disagree about a window's occurrences, `availableMinutes` and the scheduler's free
runs will disagree about the same week.

### Decisions the contract does not spell out

The cross-track test compares code *sets*, so every place this oracle went beyond the contract's
letter is a place the two implementations may legitimately differ. All of them are commented at the
rule in `oracle.ts`; they are collected here so a merge does not have to find them:

1. **`INVALID_INTERVAL` covers a window minute outside `0..1440`.** The contract documents
   `endMinute <= startMinute`. A window claiming minute 2000 is not merely untidy: counted naively it
   adds capacity no clock ever showed, and the overload judgement built on `availableMinutes` then
   reads as free time that does not exist.
2. **`DEADLINE_BEYOND_HORIZON` is symmetric.** A deadline *before* the horizon starts is outside it
   just as much as one after it ends, and extending the horizon backwards would change the answer —
   which is the property the contract uses to separate this code from having no time.
3. **`EFFORT_EXCEEDS_ITEM_WINDOW` is only considered for an item that is otherwise clean.** It is a
   derived consequence, and an item already told its effort is unknown does not need to be told the
   arithmetic that follows from it.
4. **`NO_WORKING_WINDOW` is suppressed when a window-level finding already explains the emptiness.**
   A code that only ever co-occurs with another looks like independent evidence and is not.
5. **`SELF_DEPENDENCY` and `UNKNOWN_DEPENDENCY` are charged regardless of dependency kind.** An
   informational edge forces no ordering, but an edge pointing at nothing is a broken reference.
6. **`AMBIGUOUS_LOCAL_TIME` is reachable only through an unrecognised `foldPolicy`.** `FoldPolicy`
   always states a side, so with a well-typed config the fold is resolved rather than reported —
   which is what the contract says. The code exists for callers arriving across a trust boundary.
7. **An unresolved fold drops the occurrence from `availableMinutes`.** Taking either candidate would
   silently choose a side the config declined to choose.

If #29 reads any of these differently, that disagreement is the finding the sprint was designed to
surface. It is not a bug in one side to be quietly patched to match the other.

## 3. Kind coverage is a refusal

`PlanningScenarioKind` has eight members and the contract asks that "a suite with no DST scenario
should fail to assemble, not quietly pass". `assemblePlanningCorpus` therefore **throws** when a kind
has no rows, and `tests/planning/scenarioCorpus.test.ts` removes each kind in turn and asserts the
throw. A corpus that merely *counted* its kinds would let a merge that dropped them ship green.

| Kind | Rows | What they turn on |
|---|---|---|
| `feasible` | curated + generated | The baseline: ample capacity, everything places. |
| `overload` | curated | 120 minutes of capacity against 180 of demand; the lowest priority loses. |
| `conflict` | curated | Two blocking events double-booked; and an item that must abut a meeting exactly. |
| `dependency` | curated | Cycle, self-edge, dangling edge. |
| `dst` | curated | New York and Jerusalem, both directions. |
| `boundary` | curated + generated | Midnight, deadline past the horizon, no window, zero-length event, `+05:30`. |
| `multilingual` | curated | `ar-SA`/Asia/Riyadh, `he-IL`/Asia/Jerusalem, `en-US`/America/New_York. |
| `change` | curated | A `-before`/`-after` pair over one scope; the input churn is measured across. |

A `dst` row must **straddle a real transition** — the gate reads the offset at the horizon's two ends
off the runtime's own tzdata and refuses a row whose zone does not move. A tzdata update that shifted
a transition fails here loudly instead of turning every DST case into a no-op.

An `overload` row must really be overloaded: the gate requires `demandMinutes > availableMinutes`. A
scenario labelled `overload` whose demand fits is testing something else under a misleading label,
which is what a named kind exists to prevent.

### The four DST instants

Read off this runtime's tzdata, not hand-computed:

| Zone | Transition | Local effect |
|---|---|---|
| America/New_York | `2026-03-08T07:00:00.000Z` | 02:00 → 03:00; local 02:00–02:59 is a gap. |
| America/New_York | `2026-11-01T06:00:00.000Z` | 02:00 → 01:00; local 01:00–01:59 is a fold. |
| Asia/Jerusalem | `2026-03-27T00:00:00.000Z` | Friday 02:00 → 03:00. Not the same weekday as the US. |
| Asia/Jerusalem | `2026-10-24T23:00:00.000Z` | Sunday 02:00 → 01:00. |
| Asia/Kolkata | none | `+05:30` all year — the case whole-hour arithmetic fails. |

## 4. Every expectation is machine-checkable

`ScenarioExpectation` has no free-text field. The gate additionally requires, for every row:

- the expectation accounts for **every item exactly once** — the same promise `Plan` makes;
- every expected constraint-level code is a **static** code;
- the **static half agrees with the oracle in both directions**: every code the oracle emits is
  expected, and every static code expected is emitted.

A consequence worth knowing before adding a row: a curated case may trip **one** static code per
item. Two at once cannot be used to compare two implementations, because the comparison would pass
while each side was reading a different one of them. The gate says so by name.

Attempt codes (`NO_FEASIBLE_SLOT` and friends) may appear in `expectedUnscheduledReasons`. Those are
claims about #30's scheduler, not about the oracle, and the oracle is not asked to confirm them —
the merge-owned cross-track test is.

## 5. Locked cases never enter tuning

Three guards, because a label check would prove only that a string is a string:

1. **The type.** `TunableScenario = PlanningScenario & { lockState: 'tunable' }`. A locked row is not
   assignable, so the only way one reaches a tuning list is across a boundary where the type was lost.
2. **The selection path refuses.** `selectTunableScenarios` re-derives the partition from the rows and
   **throws**, naming the offending id, rather than filtering the list clean. A filter would repair
   the leak and hide it, and every score afterwards would be fitted to its own test set.
3. **The generator cannot mint one.** Generated rows are always `tunable`: a hold-out a seed can
   regenerate is not held out.

Lock state is **carried in the row**, never inferred from an id, a file or a position. The test that
proves it flips one row's `lockState` with everything else unchanged and asserts the row moves
between the partitions. Sprint 05 wrote the reason down: a corpus that has to be *trusted* to be
described correctly will eventually be described incorrectly.

An unreadable `lockState` refuses assembly rather than defaulting. Defaulting to `tunable` would put
an unreadable row in the fitting set; defaulting to `locked` would quietly shrink it. Neither is a
decision a loader gets to make.

## 6. The generator asserts only what it can compute

Two families, and no others:

- **ample-capacity feasible** — 24 working hours against a demand that cannot fill them, so every
  item places;
- **one seeded static defect** — exactly one item carries one code drawn from
  `EFFORT_UNKNOWN`, `EFFORT_NOT_POSITIVE`, `DEADLINE_BEFORE_EARLIEST_START`,
  `DEADLINE_BEYOND_HORIZON`, `SELF_DEPENDENCY`, `UNKNOWN_DEPENDENCY`.

Those are precisely the outcomes derivable without running a scheduler. Generating a *contended*
case would mean guessing which item loses the last free hour, which is #30's judgement — and a
generated expectation that guessed it would either be trivially true or be a second, unreviewed
scheduler hiding in a data file. **Every contested outcome is a curated row**, written down with the
reasoning in its `note`.

Rows are addressed by `sha256(version:seed:index:field)` rather than drawn from a running stream, so
a row's content depends on its own index and not on how many rows were asked for. Growing the corpus
cannot re-point the rows already in it — the property `lib/decomposition/evaluation/splits.ts` makes
for split assignment, for the same reason.

## 7. Metrics, and the three empty denominators

`PlanQualityMetrics` divides three times and each division has a case with nothing underneath it. The
contract fixes all three, and each fixes an answer a reader would misread:

| Metric | Empty case | Value | The wrong answer it replaces |
|---|---|---|---|
| `placementRate` | no items | `1` | `0` reads as total failure. |
| `churnMinutes` | no previous plan | `0` | `null` forces every consumer to branch. |
| `utilization` | no available minutes | `0` | a division by zero. |

This is a deliberate departure from `lib/decomposition/evaluation/metrics.ts`, where a ratio over
zero is `null`. There the question is "how good was the decomposer" and no data must not render as a
bad score; here the contract states each figure's total. The difference is written down because both
conventions live in this repository and the next reader will otherwise assume one is a mistake.

`churnMinutes` sums `|Δ startsAt|` over items scheduled in **both** plans, measured on `interval`
rather than `reservedInterval`. Added, removed and still-unscheduled items contribute nothing:
counting an appearance as a shift of its own length would make a first run of ten items look like
maximal churn, which is the one run where nothing could have moved.

`utilization` above 1 is **reported, not clamped**. A plan that reserved more time than exists is a
planner bug and clamping would render it as a full week.

`computePlanQualityMetrics` **refuses** a plan that lists an item twice, or as both scheduled and
unscheduled. `Plan` promises the two lists cover every item exactly once; a plan that breaks it has
no meaningful score, and scoring it anyway would publish the planner's bug as a quality figure.

## 8. Adding a scenario

1. Append to `CURATED_PLANNING_SCENARIOS` in `lib/planning/evaluation/scenarios.ts`.
2. Give it a `kind`, a `lockState`, a `locale`, and a `note` saying **why the expected outcome is
   correct** — especially when it is a failure.
3. Make the expectation account for every item exactly once.
4. Isolate one static defect per item.
5. Run `npm run test:sprint07`. The gate will name anything that does not line up; it does not warn.

Mark it `locked` only if it should never inform tuning, and expect that decision to be permanent —
the point of a hold-out is that it does not move.

## 9. Migration and rollback

**Additive only.** This work adds four files under `lib/planning/evaluation/`, four test files under
`tests/planning/` (all four already registered in `package.json` on the sprint base — this branch
does not edit it), and this document.

- **No schema change.** No table, no column, no stored document.
- **No persisted data.** Nothing here writes. `PLANNING_PERSISTENCE_POLICY.planCanPersist` is false,
  a plan is a proposal about time, and this package only reads plans handed to it as values.
- **No API route, no UI, no calendar write-back, no model call.**
- **No behaviour change to any existing module.** Nothing outside `lib/planning/evaluation/` imports
  this package yet; the corpus is consumed by the tests above and, at merge, by
  `tests/planning/planningCrossTrack.test.ts`.
- **No contract edit.** `src/contracts/v1/planningContracts.ts` and `lib/planning/shared/` are
  untouched, as is `src/contracts/v1/moduleContracts.ts` (the `planning` descriptor flip belongs to
  #30).

**Rollback is `git revert` of the merge commit.** Nothing survives it: no migration to reverse, no
data to reconcile, no consumer to unwind. The only visible effect is that the four test files go back
to being registered-but-absent, which is the state the sprint base already ships.

**Forward compatibility.** `PLANNING_SCENARIO_CORPUS_VERSION` is part of every generated row's digest
input, so changing the generator requires bumping it and the change cannot happen by accident. The
corpus `digest` is a function of the row *set*, not its order, so reordering rows is not a change to
the corpus and a stored digest will not spuriously mismatch.
