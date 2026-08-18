# Priority Shadow Comparison

Sprint 05, issue [#23](https://github.com/anasakkari3/maybesitter/issues/23).
Design: `docs/superpowers/specs/2026-08-19-sprint-05-priority-calibration-design.md`, Component 3.

## What it is

A read-only comparison of two priority policies over a set of commitments. It
ranks each commitment under a **baseline** policy and under a **candidate**
policy, reports where the resulting order differs, and — the substantive part —
says *why* each difference happened.

It changes nothing. Not the shipped policy, not the agenda, not any stored
state. The comparison returns a value; a CLI writes that value to a report file.

## What it compares, and why that is not what the issue asked for

Issue #23 asks to "compare current ordering and Priority v1".

Sprint 04 made those the same code. `lib/utils/agendaScoring.ts` delegates to
`lib/priority/priorityScorer.ts`, and a 260,000-case differential fuzz confirmed
the delegated path reproduces the original arithmetic exactly. A comparison
built to the issue's literal framing would compare a thing to itself and report
zero disagreement forever: a dashboard that looks reassuring while measuring
nothing, which is worse than no dashboard, because a reader would trust it.

Reframed, and approved in the Sprint 05 design: **candidate policy versus frozen
policy**. Same scorer, different weights. That is a real comparison, and it is
what #22's "no hard constraint regresses" criterion actually needs.

The CLI encodes the lesson: a run whose candidate is value-identical to the
baseline exits non-zero with `REFUSED: ... This run measures nothing.`

## Modules

| Path | Purpose |
| --- | --- |
| `lib/priority/shadow/shadowComparison.ts` | Builds `ShadowComparisonReport`; owns the cause split |
| `lib/priority/shadow/shadowSampling.ts` | Deterministic seeded, per-key sampling |
| `lib/priority/shadow/candidatePolicy.ts` | Derives a candidate policy; computes the policy delta |
| `lib/priority/shadow/index.ts` | Public surface |
| `scripts/priority-shadow-run.ts` | CLI; owns the clock; writes the report artifact |

Contract: `src/contracts/v1/calibrationContracts.ts` (`RankDisagreement`,
`DisagreementCause`, `ShadowSamplingConfig`, `ShadowComparisonReport`).

## The cause split

This is the requirement the report exists to satisfy. A rank change caused by an
unknown feature is a **data** problem — go and collect the missing input. A rank
change caused by different weights over identical known features is a **policy**
problem — the tuning did it. One number would send a reader to debug the wrong
one.

For a commitment whose rank moved, let `changedFeatures` be the features whose
*weights differ* between the two policies (`policyDelta`), and define:

- **scoreMoved** — the commitment's own total differs between the two policies.
  Its known, re-weighted features are what moved it.
- **blind** — the commitment has an *unknown* feature that is in
  `changedFeatures`. The tuning re-weighted a term that was never measured here,
  so this commitment sat still while its neighbours moved.

| scoreMoved | blind | cause | Where to look |
| --- | --- | --- | --- |
| yes | yes | `mixed` | Both. Collect the input before trusting the tuning |
| no | yes | `missing_context` | **Data.** Collect the missing input |
| yes | no | `scorer_disagreement` | **Policy.** The tuning did it |
| no | no | `scorer_disagreement` | **Policy.** Collateral: others moved past it |

The last row is deliberate. A commitment whose score did not move and which is
missing nothing relevant changed rank only because others moved. Nothing about
its data is absent, so the change is entirely the tuning's.

`byCause` counts sum to `disagreements.length` by construction: every row gets
exactly one cause, and all three keys are always present, including the zeros. A
missing key would read as "not measured" where the truth is "measured, and
none".

### Why `dependency` and `effort` do not make everything `missing_context`

They are permanently unknown — `Commitment` carries no dependency and no effort
field — and they appear in `unknownFeatures` on **every** row, because they
genuinely are unknown and the contract asks for the unknown features.

They never make a row `missing_context`, because **no policy weights them**, so
they are never in `changedFeatures`.

That line is drawn deliberately. A *cause* must be something that differs
between the two runs. Both policies are exactly as blind to dependency and
effort as each other, so that blindness cannot explain a difference between
them. Counting it would mark every single disagreement `missing_context` or
`mixed`, make `scorer_disagreement` unreachable, and leave the split carrying no
information at all — which is the same "measures nothing" failure the reframing
of #23 exists to avoid. The standing gap is a real limitation of the feature
set; it is not a finding about any particular candidate policy.

Reading a report: `unknownFeatures` on a `scorer_disagreement` row will still
list `dependency, effort`. That is a statement about the feature set, not about
the disagreement.

## Sampling

`ShadowSamplingConfig` is `{ rate, seed }`. Selection is a pure function of
`(seed, commitmentId)` — FNV-1a over `"<seed>:<id>"`, scaled into `[0, 1)`, kept
when strictly below `rate`.

- **Reproducible.** Same seed, same corpus, same rows. This is the point;
  a `Math.random()` sampler would satisfy every count-based property and lose it.
- **Order-independent.** The corpus can be assembled in any order.
- **Stable under growth.** Adding a commitment changes only whether *that* row
  is sampled. A seeded-shuffle sampler would resample everything whenever a row
  was added, and two consecutive reports would be incomparable.
- **Nested.** A 30% sample is a strict subset of a 70% sample at the same seed,
  so the two are one experiment at two resolutions.
- **Exact endpoints.** `rate: 0` selects nothing; `rate: 1` selects everything.

A rate outside `0..1`, or a non-integer seed, is **refused** rather than
clamped: clamping would let the author of a `rate: 1.5` mistake read the report
as if it answered the question they asked.

`rankCorrelation` (Kendall tau-a) is `null` below two compared commitments, not
`1`. A correlation of 1 over zero rows would read as perfect agreement where
nothing was measured — the same error as reporting 0% agreement over an empty
judgment corpus.

## Determinism

- `generatedAt` is a **required parameter** of `buildShadowComparisonReport`.
  Sprint 04's review found that a report builder reading the system clock makes
  two runs over unchanged input produce different committed files, so a diff
  stops meaning "something changed". The CLI owns the clock.
- `now` is explicit; features are never measured against the host clock.
- Nothing under `lib/priority/**` may call `Date.now()` or construct a `Date` —
  a Sprint 04 repo-wide test enforces it and polices these files automatically.
- Subjects are sorted by commitment id before sampling, so the report is a
  function of the corpus rather than of the order it was assembled in.
- Features are extracted **once** per subject and scored under both policies.
  This is not an optimisation: identical inputs are what make the cause
  attribution sound. Two extractions could differ, and then a third explanation
  would exist that the report has no category for.
- Duplicate commitment ids are refused. Ranks are keyed by id, and a duplicate
  would quietly attribute one row's movement to another.

## Boundary guarantee

`lib/priority/shadow/**` imports no writer (`commandService`,
`deterministicStateGateway`, `src/server/dataStore`, `agendaService`, or
anything matching `*Store`), no UI surface (`src/components`, `src/app`,
`src/context`, `react`, `next`, any `.tsx`), and — the sharpest form — **no
filesystem or network primitive at all**. Shadow comparison returns a value. It
has no write path to return through.

Enforced by `tests/priority/shadowBoundaries.test.ts`, which walks the
**transitive** import closure. One hop is enough to drag a writer in:
`agendaService` imports `commandService`, so anything importing `agendaService`
reaches persistence without ever naming it.

The scanner catches bare `import 'x';` side-effect imports. That form binds no
name, so it has no `from` clause and a `from ['"]...['"]` pattern misses it
entirely — while the module still executes in full. **That gap was real in this
repo**, found in Sprint 03. The test therefore also tests the scanner itself
against a synthetic source, so the pattern cannot be dropped silently.

Content bans are applied to comment-stripped source. Scanning raw text would
flag the modules' own prose explaining why they do not call `Math.random()`, and
the cheapest way to green such a scanner is to delete the explanation — a
scanner pushing the code in the wrong direction.

## Running it

```sh
node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-shadow-run.ts

node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-shadow-run.ts \
  --weight importanceHigh=400 --weight userPressureRecent=500 --rate 0.5 --seed 11
```

| Flag | Meaning |
| --- | --- |
| `--weight <key>=<number>` | Override one candidate weight. Repeatable. Validated against the contract's key set |
| `--band-cap`, `--total-cap` | Override the candidate caps |
| `--candidate-version <id>` | Name the candidate |
| `--rate <0..1>`, `--seed <int>` | Sampling |
| `--json-only` | Skip the markdown rendering |

Output: `docs/quality/reports/priority-shadow-comparison.{json,md}`.

Corpus: `tests/fixtures/prioritySeedSet.ts` — the twenty annotation seed pairs
(forty commitments) at the fixed seed clock. **Synthetic, engineering QA only**,
labelled as such at its source. It is used because a shadow comparison needs
commitments and the product ships none; `lib/priority/rubric/**` reads the same
corpus for the same reason.

With no override the CLI uses a candidate labelled
`priority-policy-candidate-demo`. It is a perturbation chosen to exercise the
mechanism, **not a proposed tuning**. Sprint 05 fits no weights to real
judgments because no real judgments exist, and a default that looked like a
recommendation would be the exact confusion the empty judgment corpus exists to
prevent.

## Migration

There is nothing to migrate.

- **No schema change.** `calibrationContracts.ts` was committed before this
  work and is unmodified. No new persisted shape exists.
- **No data migration.** The comparison reads commitments and reminders in the
  shapes `lib/priority/priorityFeatures.ts` already reads. It writes no store,
  no file under `data/`, and no user state.
- **No behaviour change.** `DEFAULT_PRIORITY_POLICY` is untouched and frozen.
  `lib/utils/agendaScoring.ts`, `agendaService`, and every ranking a user sees
  are byte-for-byte what Sprint 04 shipped. Nothing in the product imports
  `lib/priority/shadow/**`; the only caller is the CLI.
- **No runtime cost.** No always-on path, no scheduled job, no instrumentation
  hook. The comparison runs when a person runs it.

The one new artifact is `docs/quality/reports/priority-shadow-comparison.{json,md}`,
alongside the report files the other quality CLIs already write.

## Rollback

Rollback is deletion, and it is safe at any point because nothing depends on
this code.

1. Delete `lib/priority/shadow/`, `scripts/priority-shadow-run.ts`,
   `tests/priority/shadow*.test.ts`, `tests/priority/shadowFixtures.ts`,
   `docs/quality/reports/priority-shadow-comparison.*`, and this document.
2. Remove the four shadow test files from the `test` script in `package.json`
   (registered centrally at merge; this track does not edit `package.json`).
3. Nothing else. There is no migration to reverse, no flag to flip, no store to
   drain, and no consumer to update — `git grep 'priority/shadow'` returns only
   the files above.

Partial rollback of the CLI alone (keep the library, drop the entrypoint) is
also safe: `buildShadowComparisonReport` is a pure function and its tests do not
use the CLI. Dropping the library while keeping the CLI is not — the CLI would
not resolve.

**A rollback cannot corrupt a ranking**, because no ranking ever consulted this
code. That is the practical payoff of the boundary test: the module's inability
to write is what makes its removal a non-event.

## Deliberately out of scope

- **Choosing which candidate to try.** That is the calibration search (#22).
  This module measures the candidate it is handed.
- **Shipping a candidate.** A report is not a config. Moving weights means
  editing `lib/priority/priorityPolicy.ts` and failing
  `tests/priority/policyFreeze.test.ts` in review — visible, deliberate, and
  not something a shadow run can do.
- **A UI surface.** Explicitly a Sprint 05 non-goal, and structurally
  impossible from this module.
- **Deriving the agenda band.** `reason` is supplied by the caller. It comes
  from the agenda query rather than from the weights, and deriving it here would
  let a candidate policy appear to move an item that had merely been
  re-classified — a fourth cause the report has no category for. It also keeps
  the module out of `agendaService`, which reaches persistence.
