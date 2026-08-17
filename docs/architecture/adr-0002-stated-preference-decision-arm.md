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

- `PreferenceMemory { id, userId, statement, scope, strength: 'soft'|'hard', polarity: 'prefer'|'avoid', confidence, status, evidenceIds, supersedesPreferenceId?, requiresConfirmation, createdAt, updatedAt }`
- `FactMemory { id, userId, statement, scope, confidence, status, evidenceIds, supersedesFactId?, requiresConfirmation, createdAt, updatedAt }`
- `PreferenceEvent` / `FactEvent`, structurally identical to `CommitmentEvent` (`created` / `corrected` / `confidence_adjusted`, with `reason`, `actor`, and `from`/`to` status and confidence).

`requiresConfirmation` mirrors `CommitmentMemory`'s field of the same
name and is what makes §3's confirm band a real state rather than a
label — see §3.

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

Concretely, both halves of that guarantee are enforced in code:

- **Audit trail on auto-link.** `update()` compares old against new
  before mutating and emits one `corrected` event whenever any
  substantive field actually changed (`statement`, `strength`,
  `polarity`, `status`, `requiresConfirmation`), plus one
  `confidence_adjusted` event (carrying `fromConfidence`/`toConfidence`)
  when confidence changed. Status is not special-cased: the ingestion
  auto-link path never sends `status`, so a status-only check would let
  a polarity flip ("prefer" → "avoid") land silently.
- **Pending confirmation is a real state.** `PreferenceMemory` and
  `FactMemory` carry `requiresConfirmation: boolean`, mirroring
  `CommitmentMemory`'s field and set by the same
  `resolution.action === 'confirm_link'` test the commitment branch
  already uses (`true` on `confirm_link`, `false` on `link` and
  `create_new`). The decision arm skips `requiresConfirmation` records
  the same way it skips non-active and below-floor ones, so two
  textually-similar-but-different statements on one scope cannot both
  influence ranking while one of them is still unconfirmed.

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
- Scope derivation (`memoryPolicy.ts`'s `SCOPE_KEYWORDS`) covers all
  three languages the extractor detects. It has to: an unmatched
  statement falls back to its own full text as the scope, which never
  substring-matches a commitment title, so a missing keyword makes that
  language a silent no-op on arm scoring rather than a visible failure.

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

Scoring: for each baseline-eligible candidate, look up
facts/preferences whose `scope` matches the commitment (keyword overlap
against title/kind). A statement is only considered if it is `active`,
not `requiresConfirmation`, and at or above a 0.5 confidence floor;
below the floor it contributes nothing at all (an on/off gate, not a
small effect). `strength` × `polarity` then maps to an effect:

| polarity | strength | effect  | magnitude              | class |
|----------|----------|---------|------------------------|-------|
| prefer   | soft     | bonus   | `+2 × confidence`      | soft |
| prefer   | hard     | bonus   | `+4 × confidence`      | hard |
| avoid    | soft     | penalty | `-2 × confidence`      | soft |
| avoid    | hard     | veto    | — (removes the candidate) | hard |

A matching fact always contributes a soft bonus of `+1 × confidence`
(facts state what is true, not a ranked preference, so they don't veto).
Magnitudes are proportional to confidence rather than fixed constants,
so §6's feedback nudges move ranking continuously instead of doing
nothing until a nudge happens to cross the floor.

**Soft signals are tier-bounded; hard signals are not.** Candidates are
ranked by: (1) hard prefer bonus, (2) the baseline's own urgency tiers
(`latenessBand` → `urgencyBand` → `importanceBand`), (3) soft bonuses
and penalties, (4) the baseline's remaining tiebreaks. Putting the
baseline's tiers above soft signals is what makes "a soft preference is
outweighed by overdue urgency" true: a mild preference reorders within
an urgency tier but can never pull a candidate past a genuinely more
urgent one. Hard signals keep the latitude the name implies — the veto
removes a candidate outright, and a hard prefer bonus is allowed to
outrank the baseline's tiers.

Produces a decision trace: `{ kind: 'fact'|'preference', id, statement,
confidence, effect: 'bonus'|'penalty'|'veto', magnitude }[]`, where
`magnitude` is the confidence-scaled value actually applied, following
the same `ArmAdjustment`/evidence-label pattern the `contextual` and
`personalized` arms already use. A veto can only remove a candidate from
contention within the baseline-eligible set — it still cannot admit one
the baseline excluded.

This is the first arm to place user-authored free text (a preference's
`statement`) into `evidenceLabels`; earlier arms only used fixed
system-generated strings. Those statements are screened with
`nextStepReviewService`'s own `isSafeText` tone guard before being
surfaced, and if a proposal still fails review the arm reports
`selectedCommitmentId: null` rather than a pick nothing surfaced.

### 6. Feedback — benchmark-only, not wired to live analytics

`applyDecisionFeedback(stores, trace, outcome, reason)`: for each trace
entry that contributed a **bonus or penalty**, nudge that statement's
`confidence` — up on an accept/done (+0.03, capped 0.99), down on a
dismiss/edit/defer (-0.05, floored at 0.2 — never deleted, stays
inspectable and can recover). **Veto entries are excluded outright**: a
veto removed its candidate from contention, so the decision the user
then made was about a *different* commitment and carries no evidence
about whether the vetoing constraint was right. A preference's
`strength`/`polarity` never changes from feedback, only `confidence`.
Because §5's magnitudes scale with confidence, these nudges change
ranking weight continuously rather than only at the 0.5 floor. This
function is called explicitly by benchmark scenarios, not by
`emitAnalyticsEvent` — it does not touch the live pilot's analytics or
trust pipeline.

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
- Benchmark: new `tests/experiments/statedPreferenceArm.test.ts` (plus
  `statedPreferenceFeedback.test.ts` for the confidence-decay scenario),
  ≥8 scenarios — explicit fact breaks a tie baseline/personalized can't
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
