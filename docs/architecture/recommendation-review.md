# Recommendation review surface

Sprint 08, issue [#35](https://github.com/anasakkari3/maybesitter/issues/35) —
*Build recommendation review interaction*. Written against #33's
`src/contracts/v1/recommendationContracts.ts`.

This is the module-level review surface for the `recommendation` intelligence
module: it presents a `Recommendation` as a **proposal**, explains why it is
being offered, and gives the reviewer accept / edit / defer / dismiss / done
paths — none of which write anything.

## What ships

| File | What it is |
| --- | --- |
| `lib/recommendation/review/reviewContract.ts` | The review request/response contract: what a reviewer is shown, what they may decide, what a submission looks like. Types, closed vocabularies, frozen policy. |
| `lib/recommendation/review/copy.ts` | Every human-readable string, in `en` / `ar` / `he`, selected by closed code. No interpolation anywhere. |
| `lib/recommendation/review/present.ts` | Pure. `Recommendation` → view model; submission → outcome; unknown body → response. No React, no clock, no I/O. |
| `src/app/api/recommendation/review/route.ts` | `POST /api/recommendation/review`. Parses a body, calls `handleReviewRequest`, serialises. |
| `src/components/RecommendationReview.tsx` | A thin renderer over the view model. No copy, no decision logic, one piece of state. |
| `tests/recommendation/reviewContract.test.ts` | The presenter and the contract. |
| `tests/recommendation/reviewAccessibility.test.ts` | Structural accessibility guards — **read its header for what they do not prove**. |
| `tests/recommendation/reviewApi.test.ts` | The route: no persistence, malformed input reported not thrown, redaction on the wire. |
| `tests/recommendation/reviewFixtures.ts` | Shared fixtures, each checked against #33's own `checkRecommendation`. |

## Relationship to the shipped V03 pilot

`src/contracts/v1/nextStepContracts.ts`, `src/components/NextStepReview.tsx` and
`/api/next-step` already ship a working one-next-step review interaction. **None
of them is changed by this work**, nothing here imports them at runtime, and the
pilot's wire format is untouched.

Sprint 06's recorded cost of shipping two complete implementations of one
mechanism was four review rounds, each finding a defect already fixed on the
other side. So the split has to be justified structurally, not stylistically:

- `NextStepReview.tsx` is on the `nextStep*` surface and is out of scope for
  #35. Extending it was not an option available to this issue.
- Even wrapping it unchanged would require adapting a `Recommendation` into a
  `NextStepRecommendationContract`, whose `primaryStep` is one nullable
  `{ commitmentId, title }`. That projection *is* the `{ primary, alternatives }`
  collapse #33's decision 2 exists to make unconstructible, and it is invisible
  because the result still renders correctly.
- It would also make the pilot's pre-rendered English `evidenceLabels` a data
  contract for the module, which #33 forbids at `EvidenceCategory`.

What is deliberately *shared* rather than reinvented: the five verdicts are
spelled exactly as the pilot spells them (`Choose`, `Edit`, `Later`, `Dismiss`,
`Already done`, and their `ar`/`he` equivalents), and the confirmation rule is
stated once in `CONFIRMING_VERDICTS` and read by the presenter, the decision
evaluator and the component through the view model.

## Acceptance criteria, and where each is enforced

### Nothing persists before explicit confirmation

This is a **shape** property, not a convention:

- `ReviewConfirmation` is a discriminated union — `{ stage: 'unconfirmed' }` or
  `{ stage: 'confirmed', acknowledgedVerdict, acknowledgedIndex, confirmedAt }`.
  It is not `confirmed?: boolean`, so a missing confirmation is not a falsy
  value, it is not a confirmation. This is
  `DecompositionConfirmationRequest`'s rule — the set the user did not accept is
  stated rather than inferred — applied to a single decision.
- A confirmation **restates its target**. A confirmation naming a different
  verdict or position than the decision it accompanies is
  `CONFIRMATION_TARGET_MISMATCH`. A boolean flag cannot express that failure, so
  a confirmation that has drifted (the user confirmed the first option, the offer
  re-rendered, the decision now targets the third) would silently authorise a
  write against something the user never saw.
- `ReviewPersistenceHandoff` is the only value an adapter will accept as
  authority to write, and it appears in exactly **one** branch of
  `ReviewDecisionOutcome` — the branch reachable only from a confirmed
  submission. `defer` and `dismiss` never produce one, confirmed or not.
- Every response and every outcome branch carries `persisted: false` as a
  *literal type*, so "we wrote it" is not expressible on this wire format.
- The route's import closure reaches no writer. `reviewApi.test.ts` walks it and
  asserts so, because the behavioural half would keep passing the day someone
  added a store write that did not change the response body.

### Keyboard and screen-reader flows

**This repo has no DOM test infrastructure** — no testing-library, no jsdom, no
playwright, no cypress, no vitest, no jest; Node's built-in runner only. Adding a
browser test stack is a large dependency change that was not reviewed as part of
this issue, so it was not added.

What was done instead:

1. **Everything that can be wrong lives in `present.ts`**, which is pure and
   tested for real. The component chooses no string, decides no confirmation
   rule, builds no submission, reads no clock and generates no id.
2. **The markup is verified structurally**, by reading the component source, in
   the style of `tests/planning/planningBoundaries.test.ts` and
   `tests/decomposition/boundaryImportClosure.test.ts`. The guards assert: every
   control is a real `<button type="button">` with an accessible name; no
   positive `tabIndex`; exactly one `aria-live="polite"` region and never
   `assertive`; every `aria-labelledby` names an id the file actually renders;
   headings descend without skipping; `dir` comes from the view model rather than
   being hardcoded; and no click handler sits on a non-interactive element.

**What that proves, and what it does not.** It proves the markup carries the
affordances. It does **not** prove focus order, that a real screen reader
announces correctly or at the right moment, that `sr-only` is off-screen rather
than `display: none`, contrast, reflow, or any runtime behaviour at all. A green
run on `reviewAccessibility.test.ts` must not be reported as a passing
accessibility audit. The test file says this in its own header for the same
reason.

**Deferred:** driving this component in a real browser with a real assistive
technology — focus order, announcement timing, and a manual WCAG audit. That
needs a browser test stack and a decision about which one, which is a separate
change.

### First-pass hidden data is not exposed in blind evaluations

"First pass" is the calibration sense recorded in `lib/calibration/contracts.ts`:
a blind second pass that can see the first pass's own judgement is measuring
agreement with the first pass rather than measuring the thing.

The first pass's judgements here are: **which option it preferred** (the offer
order and the lead), **how sure it was** (`confidence`, `band`), **why the option
is alone** (`soleness`), and **what it ruled out** (`excluded`, whose
`LOWER_RANKED` and `OPTION_CAP_REACHED` codes name the ranking directly).

Redaction is a **shape** property, in three layers:

- `BlindReviewView` and `BlindReviewSlot` have no `optionIndex`, no
  `confidence`, no `confidenceLabel`, no `soleness`, no `lead`/`alternatives`
  split and no `excluded`. There is no field to forget to omit.
  `BLIND_REDACTED_FIELDS` names them as data, and the test walks a built blind
  view *and its JSON serialisation* asserting none of them appears at any depth.
- Slot ordering is a pure function of the options' **actions** and a
  caller-supplied salt. It never reads `optionIndex`, `confidence` or the array
  order, so it carries no rank information. `reviewContract.test.ts` proves this
  by flattening every option's confidence to one value and asserting the order
  does not move.
- A blind reviewer's `ReviewTarget` carries `slotIndex`, not `optionIndex`, so a
  blind client cannot *express* an offer position. The slot→option mapping is
  recomputed server-side from the salt and never leaves the server. Submitting an
  attributed target against a blind review is `TARGET_MODE_MISMATCH`.

**Residual signal this shape does not remove.** The number of support reasons on
a card, and which reason codes appear, still correlate with rank — a lead option
tends to have more support. Those are the substance a rater is meant to judge, so
they are not redacted, but a study that needs the correlation gone will have to
control for it rather than rely on this contract.

**Not a secrecy mechanism.** The slot ordering uses a non-cryptographic FNV-1a
mix. It hides the offer order from an evaluator; it does not defend against an
adversary who has the salt and the candidate actions.

### Tests, documentation, migration and rollback

This file, and the three test files above. Migration and rollback follow.

## Cross-cutting rules

- **No ambient clock.** `now`, `decidedAt` and `confirmedAt` are all required
  inputs. Nothing in `lib/recommendation/**` or the route calls `Date.now()`,
  `new Date()`, `Math.random()` or `randomUUID`; a structural test asserts it.
  The shipped pilot route *does* read the clock — that is fine for a surface that
  recomputes every request and never holds a proposal. This module's output is
  meant to be held, which is why it has an expiry, and an expiry check that reads
  the clock is unreplayable in an audit.
- **No `localeCompare`.** The one ordering that affects output — root source
  kinds in the explanation, and the blind slot order — uses `compareByCodePoint`
  from `lib/planning/shared/compare.ts`.
- **No caller-chosen identifier in any human-readable string.** `commitmentId`,
  `proposalId`, `itemId` and `recommendationId` travel only in typed fields a
  consumer can drop. Element ids are derived from position
  (`recommendation-review-option-0`), never from input. The test walks the whole
  view for a fixture id spelled `call-dr.cohen-about-the-biopsy` — the shape of
  the leak Sprint 07 recorded — and asserts *every path* it reaches ends in one
  of those four field names.
- **Validate before rendering.** `presentRecommendation` runs #33's
  `checkRecommendation` and `evaluateRecommendationStaleness` before building an
  offer, even though #34's selector is expected to run them before emitting.
  Sprint 05's rule is that a check owned by the thing it checks is not a check,
  and #33 states at `checkRecommendation` that both sides run it deliberately.

## The wire format

One verb, `POST`, with a discriminated body.

```jsonc
// present
{
  "kind": "present",
  "recommendation": { /* a #33 Recommendation */ },
  "locale": "en",                     // en | ar | he
  "mode": "attributed",               // attributed | blind
  "blindingSalt": "…",                // required when mode is blind
  "now": "2026-08-19T10:30:00.000Z",  // required; never defaulted to a clock
  "currentFingerprints": { "obs-due": "fp-due-1" }  // optional; absent fails closed
}
```

```jsonc
// decide
{
  "kind": "decide",
  "recommendation": { /* … */ },
  "locale": "en",
  "mode": "attributed",
  "now": "2026-08-19T10:30:00.000Z",
  "submission": {
    "recommendationId": "…",
    "target": { "mode": "attributed", "optionIndex": 0 },
    "verdict": "accept",
    "decidedAt": "2026-08-19T10:30:00.000Z",
    "confirmation": { "stage": "unconfirmed" }
  }
}
```

Responses are `presented` / `decided` / `rejected`, all carrying
`persisted: false`. A rejection is a `400` with findings from
`REVIEW_FINDING_CODES`; there is no path that returns a `5xx` for a malformed
input.

**Why the recommendation travels in the request.** #34's selector is not merged.
A route that fetched a recommendation would have had to ship a second selector,
which is the duplication this sprint is avoiding. When #34 lands, `present` gains
a variant naming a scope and the route resolves it; `decide` does not change,
because it re-validates whatever it is handed regardless of where it came from.

## Migration

Additive. Nothing that shipped before this change behaves differently.

- **No schema, store or data migration.** This surface reads nothing and writes
  nothing. There is no table, no file, no store and no cache to migrate.
- **No change to `/api/next-step`.** Its route, contract, service and component
  are untouched. Existing clients continue to work byte-for-byte.
- **No new npm dependency.** The FNV-1a mix and the code-point comparator are
  both already in-repo or three lines long, deliberately, so this change adds
  nothing to the lockfile.
- **New route.** `/api/recommendation/review` did not exist before. It has no
  authentication or pilot-access gate of its own yet, because it holds no user
  data and reaches no store — it transforms a document the caller already has. A
  gate becomes necessary the moment `present` gains the scope-resolving variant
  in #34, and that is the change that must add it.
- **`RecommendationReview.tsx` is mounted by nothing.** There is no producer to
  feed it until #34 lands, so it is not wired into a page. That is deliberate:
  wiring it to a stub would put a fabricated recommendation in front of a pilot
  user.
- **Test registration.** The three test files are *not* currently reachable from
  any `package.json` script — there is no `test:sprint08` entry, and `npm test`
  does not list them. Whoever adds `test:sprint08` should include:

  ```
  tests/recommendation/reviewContract.test.ts
  tests/recommendation/reviewAccessibility.test.ts
  tests/recommendation/reviewApi.test.ts
  ```

  Until then they run only when named explicitly, which means **they are not
  gating anything in CI**. This is the single most important line in this
  section.

## Rollback

Fully reversible, in one step, with no data consequences — because there is no
data.

1. **Full revert.** Delete `lib/recommendation/review/`,
   `src/app/api/recommendation/review/`, `src/components/RecommendationReview.tsx`,
   `tests/recommendation/` and this file. Nothing else in the repo imports any of
   them — `reviewApi.test.ts`'s closure walk is what keeps that true — so the
   revert cannot leave a dangling import. `npm test`, `npm run typecheck` and
   `npm run build` return to their pre-change state.
2. **Partial rollback: disable the surface, keep the contract.** Delete only
   `src/app/api/recommendation/review/route.ts` and
   `src/components/RecommendationReview.tsx`. The contract and presenter are pure
   library code with no entry point; leaving them costs nothing at runtime and
   keeps #34 able to build against the types. `reviewApi.test.ts` must be deleted
   with the route.
3. **Rollback while a decision is in flight.** There is no such state. A staged
   decision lives in one React `useState` in the browser; a confirmed decision
   produces a `ReviewPersistenceHandoff` that this module hands to a caller and
   does not store. Removing the route can lose an in-flight request, and that
   request had written nothing, so a client retry after rollback is safe and a
   client that never retries has lost nothing but a keystroke.
4. **No feature flag is required**, and none is added. A flag would be a second
   place the surface can be off, and the surface is already off for every user
   because it is mounted nowhere. When #34 lands and this is wired into a page,
   *that* change is the one that needs a flag, and it should reuse the existing
   runtime controls rather than inventing one here.

## Known gaps

- The three test files are not registered in any `package.json` script — see
  Migration. They pass when run explicitly; they gate nothing until registered.
- Real-browser and real-assistive-technology verification is deferred, as
  described above.
- Reason multiplicity is a residual rank signal in blind mode, as described
  above.
- `present` cannot yet resolve a recommendation from a scope; it must be handed
  one. That is #34's to change.
