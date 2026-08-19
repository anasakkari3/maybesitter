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
  authority to write. It is **not part of `ReviewDecisionOutcome` at all**, and
  therefore not part of any HTTP response: `evaluateReviewSubmission` returns it
  as a sibling of the outcome, and `handleReviewRequest` drops it. An earlier
  revision put it inside the `confirmed` branch, which meant a *blind* reviewer's
  confirmation came back carrying `handoff.optionIndex` — see the blind section
  below. `defer` and `dismiss` never produce one, confirmed or not.
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

Three defects were found by *reading the JSX* after the first review, all of
which the structural guards now pin:

- **Focus was destroyed on every completed action.** Confirming or cancelling
  unmounted the `div` holding the button that had focus, dropping it to `<body>`,
  so a keyboard user restarted from the top of the document after every decision.
  There is now one exit path that restores focus to the control that opened the
  panel.
- **No `aria-expanded`** on the verdict controls that open the confirmation
  panel — a disclosure announced identically open or shut.
- **The confirmation prompt was never announced.** The live region emitted
  `confirmNotice`, which is the same sentence already rendered statically above
  the cards, and `notice ?? …` meant a server notice permanently swallowed later
  staged announcements.

**What that proves, and what it does not.** It proves the markup carries the
affordances, and that a focus-restoration path exists. It does **not** prove
focus *order*, that the restoration actually works in a browser, that a real
screen reader announces at the right moment, contrast, or reflow. A green run on
`reviewAccessibility.test.ts` must not be reported as a passing accessibility
audit. The test file says this in its own header.

(`sr-only` was previously listed here as unprovable. It is not: the component
uses Tailwind's clip-based utility and the test asserts the project does not
override it with `display: none`, which would silently mute the live region.)

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
  recomputed server-side from the salt and never leaves the server.
- **Write authority is not part of the response type.** This is the third layer
  and it exists because the first two were not enough: the resolved offer
  position rode back inside `handoff.optionIndex` on a confirmed blind decision,
  and three confirmed decisions recovered the whole permutation. Removing the
  field from the response *type* — rather than redacting it for blind mode —
  means there is no mode-dependent step to get wrong.

`TARGET_MODE_MISMATCH` is **not** a defence against a hostile client: `mode` is
declared by the same request, so a caller that wants an attributed exchange asks
for one. It catches a client bug — a blind session wired to the attributed submit
path — and a replayed submission from the other mode. The property that keeps
offer order away from a blind reviewer is that a blind exchange never returns
it.

**Residual signal this shape does not remove, stated at its measured strength.**
The number of support reasons on a card is not merely *correlated* with rank on
this fixture — it is a **deterministic oracle**. Across 500 salts, "the slot with
the most `whyThisNow` entries" identified the first pass's lead **500 times out
of 500**. `citedNodeCount` and `rootSourceKinds` carry the same signal.

At 100% accuracy from one visible attribute, **a blind arm is not blind** for
offers shaped like this one, and an earlier draft of this document was wrong to
call it a correlation a study could "control for". Reason multiplicity is the
substance a rater is meant to judge, so it is not redacted — but any study using
this surface must either equalise reason counts across options before blinding,
or accept that the blind arm is unblinded. `reviewContract.test.ts` pins the
measurement at 200 salts so that if the relationship changes, this paragraph is
updated with it.

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
- **Test registration.** Resolved. `3a8158b` added `test:sprint08` to
  `package.json` and it lists all three review test files, so they gate in CI.
  They remain absent from the top-level `npm test` script, which is how every
  other sprint's suite is arranged.

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

## Input limits

`RECOMMENDATION_REVIEW_LIMITS` bounds evidence nodes (500), parents per node,
offered options, excluded candidates, reasons, evidence references per reason,
and `editedTitle` length — all before anything reaches #33's checkers.

**The original justification is now half-obsolete and saying so matters.** The
limits were added because a structurally *valid* recommendation with an
8,000-node linear derivation chain (~1 MB) took `resolveEvidenceRoots` past the
stack limit and returned a 500, and 20,000 nodes burned 5.4 seconds of CPU first.
#33's `3a8158b` made that walk iterative and removed the quadratic term in the
cycle detector: re-measured here, **150,000 nodes / 19 MB now completes in
157 ms**. Both original findings are resolved upstream.

The limits are still enforced for a reason that is about the route rather than
the algorithm: App Router handlers have no default body cap, so this
unauthenticated endpoint would otherwise accept a body of arbitrary size and
allocate in proportion to it. Refusing the input is the boundary's job whether or
not the code behind it is fast.

## Division of labour with #33

The first revision of this boundary was a shallow envelope check that handed
everything else to `checkRecommendation`, which was typed
`(recommendation: Recommendation)` and total over nothing else — twelve malformed
bodies escaped `POST` as unhandled `TypeError`s. The second over-corrected into a
200-line validator that re-derived node kinds, parent lists, confidence shape,
reason lists and the `choice` minimum, all of which are questions #33 answers with
a named code.

After merging `3a8158b`, this was **re-measured rather than assumed**: with the
local validator disabled entirely, ten of the twelve came back as reported
defects and only one still threw. So the validator shrank to what is genuinely
the boundary's:

1. **The envelope** — an id, a validity window, an evidence node list that is a
   list, and a known outcome, so `checkRecommendation` can be *called*.
2. **Resource limits** — a property of being a public HTTP surface, not of being
   a recommendation.
3. **One narrow guard** that every offered/excluded entry and its `action` is an
   object, documented below.

Decision validation is delegated to #33's `checkRecommendationDecision` — index
bounds, the whole-offer rule, verdict validity, the edit-title rule and the id
match — and its codes are translated into this surface's taxonomy so a reviewer
is told about the control they used, with `position` reported in their own
vocabulary. The only bound that stays here is "is this *slot* in the blind
ordering", because slots are this module's invention and the contract has no
vocabulary for them.

The difference is visible to callers, and it is the behaviour this contract
described from the start: a malformed **envelope** is a `400`, while a
structurally **defective** recommendation is a `200` carrying a
`NothingToReviewView` whose `defectCodes` name what is wrong.

## Reported upstream to #33

Neither is patched here; this surface must not edit the contract.

1. **`actionKey` throws on a non-object action.** `checkRecommendation` calls
   `actionKey` on every offered and excluded action, and `actionParts` switches
   on `action.kind`, so `action: null` is a `TypeError` from
   `recommendationContracts.ts:250`. This is the one case of twelve that still
   threw after `3a8158b`. Guarded locally by `checkActionsAreObjects` so a public
   route does not return a 500 while the gap is open.
2. **`INSTANT_PATTERN` is not exported.** The instant ruling says a no-offset
   instant is malformed, and this boundary must apply the same rule to
   `decidedAt` and `confirmation.confirmedAt`, which no contract function checks.
   `INSTANT_PATTERN` and `instantToMillis` are both module-private, so the rule is
   currently spelled a second time in `present.ts` — marked at its definition as
   a duplicate to be deleted the moment the constant is exported. `now` is
   already delegated: `evaluateRecommendationStaleness` reports `INVALID_INSTANT`
   for it.

## Known gaps

- Real-browser and real-assistive-technology verification is deferred: focus
  *order*, whether the focus restoration works in practice, and announcement
  timing. That needs a browser test stack and a decision about which one.
- Reason multiplicity is a **deterministic** oracle for the lead in blind mode,
  at measured 100% accuracy. See the blind section.
- `present` cannot yet resolve a recommendation from a scope; it must be handed
  one. That is #34's to change, and it is the change that must add an
  authentication gate to this route.
