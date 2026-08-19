# Recommendation contract and evidence graph

Sprint 08, issue [#33](https://github.com/anasakkari3/maybesitter/issues/33).
Contract: `src/contracts/v1/recommendationContracts.ts`.
Tests: `tests/recommendation/contractSchema.test.ts`,
`tests/recommendation/evidenceGraph.test.ts`,
`tests/recommendation/expiryRules.test.ts` (`npm run test:sprint08`).

A recommendation answers "what should I do next". It is a **proposal**: offered,
never written. Priority (S04-05) said what matters and Planning (S07) said when
it fits; Recommendation says which move to make now, what else was on the table,
how sure it is, what it read to decide, and when that reading stops being true.

## Relationship to the shipped V03 pilot

`src/contracts/v1/nextStepContracts.ts`, `lib/services/nextStepBaseline.ts`,
`lib/services/nextStepReviewService.ts`, `src/components/NextStepReview.tsx` and
`src/app/api/next-step/route.ts` already ship a one-next-step surface. **This
contract does not replace them, does not import them, and changes nothing about
that route's wire format.**

| | `nextStepContracts` | `recommendationContracts` |
|---|---|---|
| Authoritative for | the deployed `/api/next-step` wire format | the `recommendation` intelligence module |
| Consumers | `NextStepReview.tsx`, the Flutter pilot client | #34's selector, #35's review surface |
| Stability obligation | a deployed client depends on it | may change until the module ships |

Every overlap is labelled at the type in the contract file, as one of **same
concept at module scope**, **superset**, or **deliberately different**:

| Pilot | Module | Relation |
|---|---|---|
| `BaselineScore.exclusionReason` (`not_confirmed \| closed \| invalid_time \| null`) | `ExclusionReasonCode` | Same concept. The module's is non-nullable and adds `LOWER_RANKED` / `OPTION_CAP_REACHED`; the pilot drops out-ranked candidates silently. |
| `NextStepState` (`ready \| empty \| insufficient_evidence`) | `outcome: 'offered' \| 'withheld'` + `WithholdingReasonCode` | Same concept. The pilot's states carry no data, so `insufficient_evidence` cannot say what was missing. |
| `BaselineScore.evidenceLabels: string[]` | `EvidenceCategory` + `EvidenceClaim` | Deliberately different. The pilot's are pre-rendered English presentation; these are provenance. A label derives from a category; a category is not recoverable from a label. |
| `NextStepDecisionContract` | `RecommendationDecision` | Superset, by exactly `optionIndex`. The verdict set is pinned identical by a compile-time assertion in `contractSchema.test.ts`. |
| `NextStepRecommendationContract.primaryStep` | `OptionSet` | Deliberately different. `primaryStep` is the `{ primary, alternatives }` shape this contract exists to forbid. |
| `NEXT_STEP_PRODUCT_POLICY` | `RECOMMENDATION_PERSISTENCE_POLICY` | Same concept at module scope, plus a clock clause and a staleness clause the pilot has no need for. |
| — | `Confidence` | New ground. The pilot has no quantitative confidence at all. |

## The five structural decisions

1. **An unsourced claim is unrepresentable.** Evidence is a graph of `observed`
   nodes (each naming a closed union of trusted-state loci) and `derived` nodes
   (each naming a **non-empty tuple** of parents). With cycles and dangling
   references rejected by `checkEvidenceGraph`, every ancestry path terminates at
   an observation. `resolveEvidenceRoots` is the executable form, and
   `evidenceGraph.test.ts` asserts the implication over 20,000 generated graphs.
2. **A lone option must say why it is alone.** `OptionSet` is `choice`,
   `sole_survivor` (one option plus a non-empty account of what was excluded) or
   `only_candidate` (one option plus evidence nothing else existed). There is no
   `primary` field to read in isolation.
3. **Staleness is a computed verdict that fails closed.** Observed nodes carry a
   `valueFingerprint`; a node with no supplied current fingerprint is
   `SOURCE_UNVERIFIABLE` and the recommendation is stale.
4. **One reason vocabulary**, partitioned support / exclusion / withholding,
   owned by no track.
5. **Confidence lives on the option**, not on the set.

## Invalidation rules, as a checker

`evaluateRecommendationStaleness({ recommendation, now, currentFingerprints })`
returns `{ fresh: true }` or `{ fresh: false, reasons: [...] }`. It never throws
and never reads a clock.

| Code | Fires when |
|---|---|
| `EXPIRED` | `now >= validity.expiresAt` (exclusive upper bound) |
| `NOT_YET_VALID` | `now < validity.basisAt` |
| `EXPIRY_NOT_AFTER_BASIS` | `expiresAt <= basisAt` — valid at no instant |
| `INVALID_INSTANT` | `now`, `basisAt` or `expiresAt` does not parse |
| `SOURCE_CHANGED` | an observed node's current fingerprint differs |
| `SOURCE_REMOVED` | the caller reports the source is gone (`null`) |
| `SOURCE_UNVERIFIABLE` | the caller supplied no entry for an observed node |

The watch set is **every** observed node in the graph, derived rather than
stored: a selective watch list would be a second copy of a subset that nothing
can check, and "we chose not to watch that one" is how a stale recommendation
survives.

Instants are compared as parsed epoch milliseconds, never lexicographically —
`…T11:00:00Z` and `…T11:00:00+00:00` are the same instant and unequal as text.

## Repo rules this contract holds

- **No ambient clock.** No `Date.now()`, no zero-argument `new Date()`, no
  `Math.random`, no `randomUUID`. `Date.parse` is the only `Date` use and is a
  pure function of its argument. Enforced by a source scan in
  `expiryRules.test.ts`.
- **Never `localeCompare`.** This file needs no string comparator at all:
  findings are ordered by input position. `RECOMMENDATION_ORDERING_KEYS` *names*
  `lib/planning/shared/compare.ts#compareByCodePoint` for #34 rather than
  copying it, since a contract must not import `lib/`.
- **No caller-chosen identifier in a `detail` string.** Details name options and
  evidence by index and sources by kind. Enforced by fuzzing both checkers with
  ids that are themselves sensitive sentences.
- **Report, don't throw**, for everything the taxonomy names, and compute the
  input digest only *after* the structural pass.

## Scope boundaries

Not in this issue: the selector (#34), the review surface (#35), any `lib/`
implementation, persistence, an API route, or the `recommendation` descriptor
flip in `moduleContracts.ts` — that flip belongs to #34, which names the entry
point.

## Migration

Additive only. One new contract file, three new test files, one new doc, and a
`package.json` script registration. No schema, no stored data, no route, no
existing module's behaviour, and nothing under `nextStep*` is touched.

There is no data migration because nothing persists a recommendation: the
contract's own `RECOMMENDATION_PERSISTENCE_POLICY.recommendationCanPersist` is
`false`, and #34 and #35 are bound by it.

`package.json` registers twelve `tests/recommendation/*.test.ts` paths — the
three this issue owns plus nine that #34, #35 and the merge will create.
Registering ahead is safe and deliberate: `node --test` given a list where some
files exist and one does not runs the ones that exist, says nothing about the
missing one, and **exits 0**. Only when *every* named file is missing does it
fail. So an unregistered or typo'd test file removes coverage with no signal,
which is what the three `registration:` tests in `contractSchema.test.ts` guard
against until integration moves them into the merge-owned cross-track file.

## Rollback

`git revert` of the sprint merge, or of this branch alone. Nothing persists
across it:

- no stored data is written or read;
- no existing route, component or service imports the contract;
- the `recommendation` entry in `INTELLIGENCE_MODULES` is untouched and remains
  a placeholder, so no audit event, kill switch or runtime control changes;
- reverting `package.json` removes the twelve registrations, which reduces the
  suite to its Sprint 07 baseline of 1951 tests.

The only ordering constraint is that #34 and #35 depend on this contract, so a
revert of this branch alone requires reverting those first.
