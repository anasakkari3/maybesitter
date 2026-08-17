# ADR 0002 — Stated-preference decision arm (Sprint 2 memory + benchmark-only arm)

## Status
Proposed (experimental, ahead of Gate #61).

## Context

`docs/strategy/CURRENT_PRODUCT_STRATEGY.md` (2026-07-29) gives a "NARROW AND
TEST" verdict and locks the Life-State & Memory, Priority, Planning, and
Personalization modules behind Gate #61 market evidence. This work
deliberately proceeds ahead of that gate at the project owner's explicit
request, to test one specific hypothesis before committing further:

> Does persistent, provenance-tracked, user-*stated* personal state
> (facts/preferences) produce measurably better next-step decisions than
> the existing behavior-*inferred* personalization arm, without
> regressing the deterministic safety invariants the recommendation
> system already relies on?

This is a narrower, falsifiable version of the broader "Personal
Operating Model" thesis. It is scoped to be answerable from a benchmark,
not from live users, so it does not require touching the V03 pilot or
its evidence collection.

`docs/MEMORY_CONTRACT.md` (Sprint 1, shipped 2026-08-03) already defines
`fact` and `preference` as RESERVED memory kinds with no runtime code,
explicitly deferred to "Sprint 2." This ADR is that Sprint 2 increment,
scoped to the minimum needed to run the benchmark above. It does not
implement `hypothesis` (Sprint 3) — no behavioral inference, no
automatic preference learning from raw activity, no personality
modeling. Those stay out of scope per the existing contract.

`lib/experiments/nextStepArms.ts` already implements an A/B arm
framework (`generic` → `contextual` → `personalized`) with a load-bearing
safety invariant: **arms may only reorder candidates the deterministic
baseline (`nextStepBaseline.ts`) already found eligible — they can never
invent or admit a candidate the baseline excluded.** This ADR's new arm
preserves that invariant rather than replacing it.

## Decision

### 1. Data model — `src/domain/memory/memoryTypes.ts`

Activate `fact` and `preference` as enabled kinds, mirroring
`CommitmentMemory`'s shape and event-sourced audit pattern exactly:

- `PreferenceMemory { id, userId, statement, scope, strength: 'soft'|'hard', polarity: 'prefer'|'avoid', confidence, status, evidenceIds, supersedesPreferenceId?, createdAt, updatedAt }`
- `FactMemory { id, userId, statement, scope, confidence, status, evidenceIds, supersedesFactId?, createdAt, updatedAt }`
- `PreferenceEvent` / `FactEvent`, structurally identical to `CommitmentEvent` (`created` / `corrected` / `superseded`, with `reason` and `actor`).

`scope` is a free-form tag (e.g. `"gym-schedule"`, `"work-schedule"`)
used for matching, not a controlled vocabulary — matching narrow
constraint statements to open-domain user text.

### 2. Stores — `src/domain/memory/{preference,fact}MemoryStore.ts`

Same `FileCommitmentMemoryStore` pattern: JSON file per kind under
`.maybesitter/`, atomic write (tmp file + rename), full event history.
No new persistence technology.

### 3. Resolution — `src/domain/memory/statementResolver.ts`

One shared resolver used by both stores (their matching logic is
identical, only the record type differs): score by `scope` equality +
normalized-text token overlap. Same thresholds as
`commitmentResolver.ts` (>=0.85 auto-link/update with a `corrected`
event, 0.60–0.84 create pending confirmation, <0.60 create new). A
second preference on the same scope never silently overwrites — it
either updates with an audit trail or waits for confirmation.

### 4. Extraction — `src/extraction/ruleBasedCandidateExtractor.ts`

New pattern families, checked *before* existing modality detection so
current commitment classification is untouched for text that doesn't
match them:

- Preference markers: "I prefer" / "I like to" / "I don't like" / "I
  usually" / "I always" / "I never" (+avoidance framing) / "بحب" /
  "ما بحب" / "بفضل" / "אני מעדיף/ה" / "אני אוהב/ת".
- Fact markers: recurring/habitual statements bound to a schedule
  pattern (reusing the existing `TIME_PATTERNS` weekday/time matchers)
  *without* an intent-modality marker — e.g. "Tuesday I work 17–20" is a
  fact; "I will work Tuesday" still classifies as `commitment` (existing
  behavior, unchanged).
- Strength/polarity classification (`memoryPolicy.ts`): "always" /
  "never" / "must" → `hard`; "usually" / "prefer" / "try to" → `soft`.

`memoryIngestionService.ts` already has the exact extension seam:
`if (candidate.candidateType !== 'commitment') { ...reason: "not handled
in Sprint 1" }`. This ADR fills that branch for `'preference'` and
`'fact'` with create/resolve/link logic mirroring the existing
commitment branch.

### 5. Decision arm — `lib/experiments/nextStepArms.ts`

New arm `'stated-preference'`. **Not added to the `NEXT_STEP_ARMS`
tuple** in `src/contracts/v1/experimentContracts.ts` — that tuple is
exactly what `resolveNextStepArm` buckets live pilot users over
(`assignExperiment(anonymousUserId, NEXT_STEP_EXPERIMENT_ID,
NEXT_STEP_ARMS)`). Instead, `selectNextStepForArm`'s parameter type
widens to `NextStepArm | 'stated-preference'`, reachable only from
direct calls in tests/benchmarks — never from a value `resolveNextStepArm`
can return. This is a structural guarantee, not a convention: the V03
pilot's live evidence collection cannot be touched by this arm without
a separate, deliberate code change to `NEXT_STEP_ARMS` itself.

Scoring: for each baseline-eligible candidate, look up active
facts/preferences whose `scope` matches the commitment (keyword overlap
against title/kind). `strength` × `polarity` maps to an effect:

| polarity | strength | effect  | magnitude scales with confidence |
|----------|----------|---------|-----------------------------------|
| prefer   | soft     | bonus   | mild |
| prefer   | hard     | bonus   | strong |
| avoid    | soft     | penalty | mild |
| avoid    | hard     | veto    | — (removes the candidate) |

A matching fact always contributes a mild bonus (facts state what is
true, not a ranked preference, so they don't veto). Produces a decision
trace: `{ kind: 'fact'|'preference', id, statement, confidence, effect:
'bonus'|'penalty'|'veto', magnitude }[]`, following the same
`ArmAdjustment`/evidence-label pattern the `contextual` and
`personalized` arms already use. A veto can only remove a candidate from
contention within the baseline-eligible set — it still cannot admit one
the baseline excluded.

### 6. Feedback — benchmark-only, not wired to live analytics

`applyDecisionFeedback(store, decisionOutcome)`: on an accept where a
preference/fact contributed a bonus/veto, nudge its `confidence` by a
small bounded step (+0.03, capped 0.99); on a dismiss/edit where it
contributed, nudge down (-0.05, floored at 0.2 — never deleted, stays
inspectable and can recover). A preference's `strength`/`polarity` never
changes from feedback, only `confidence`. This function is called
explicitly by benchmark scenarios, not by `emitAnalyticsEvent` — it does
not touch the live pilot's analytics or trust pipeline.

## Non-Goals

- No `hypothesis` memory kind (Sprint 3) — no behavioral inference, no
  auto-derived preferences from raw activity.
- No live pilot exposure. `'stated-preference'` never reaches real
  users through this change.
- No capture-time UI changes — extraction reuses the existing free-text
  capture pipeline; no new user-facing surface.
- No general open-domain fact extraction — fact detection stays scoped
  to schedule/recurrence-shaped statements matching existing temporal
  patterns.
- No cross-user data, no trained model — consistent with the existing
  `personalized` arm's constraints.

## Testing Strategy

- Unit: `preferenceMemoryStore.test.ts`, `factMemoryStore.test.ts`,
  `statementResolver.test.ts`, extended `memoryPolicy.test.ts`
  (strength/polarity), extended extractor tests (EN/AR/HE preference and
  fact patterns, plus a regression check that existing commitment
  fixtures still classify unchanged).
- Integration: extend `memoryIngestion.test.ts` for the new
  preference/fact branches.
- Benchmark: new `tests/experiments/statedPreferenceArm.test.ts`, ≥8
  scenarios — explicit fact breaks a tie baseline/personalized can't
  see; hard-constraint preference vetoes an eligible candidate; soft
  preference is outweighed by overdue urgency; explicit correction
  supersedes cleanly with an audit event; two conflicting preference
  statements land in the confirm band instead of silently overwriting;
  repeated dismissal decays a preference's confidence below effective
  influence; no facts/preferences recorded → arm output equals baseline
  exactly (regression safety net); `'stated-preference'` is absent from
  `NEXT_STEP_ARMS` (live-isolation guarantee, asserted directly).
- Regression: full existing suite (`npm test`, 385 tests) plus the
  Sprint 1 memory suite, which will also be wired into `npm test` as
  part of this change (currently implemented, passing, but not run by
  the `test` script — an existing gap, not something this ADR
  introduces).

## Rollback

Purely additive: new files, one widened type union, one new branch in
`memoryIngestionService.ts`'s existing type switch, and one addition to
`npm test`'s file list. No existing store, route, or live arm behavior
changes. Revertable by reverting the commit(s); nothing downstream
depends on the new kinds since they are never reachable from live
traffic.

## Consequences

If the benchmark shows `stated-preference` beating both `generic` and
`personalized` on scenarios requiring explicit knowledge the system
cannot infer from behavior, that is evidence (not proof) that the
broader Personal Operating Model thesis deserves further investment —
next candidate slice would be Approach 2's counterpart, real user-facing
exposure via a controlled pilot cohort, which requires a separate,
deliberate decision since it does touch live users. If the benchmark
does not show a meaningful improvement, that is equally valid evidence
that behavior-only personalization is sufficient and the broader thesis
does not currently justify further build-out ahead of Gate #61.
