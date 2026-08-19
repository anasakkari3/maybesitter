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

1. **An unsourced claim is unrepresentable in the type, and reported at the
   boundary.** Evidence is a graph of `observed` nodes (each naming a closed
   union of trusted-state loci) and `derived` nodes (each naming a **non-empty
   tuple** of parents). `resolveEvidenceRoots` is the executable form, and
   `evidenceGraph.test.ts` asserts the implication over 40,000 generated graphs.

   **An earlier draft over-claimed here** and review falsified it in one line.
   The argument was that the tuple arity plus cycle rejection makes the property
   a theorem, so no runtime code was needed. That is true of the *type* and false
   of the *value*: `JSON.parse` yields plain arrays, so `derivedFrom: []` crosses
   any network, storage or cross-track boundary — and it passed both checkers and
   the staleness verdict while `resolveEvidenceRoots` returned null for it. The
   rule that generalises: **every non-empty tuple in the contract is a hole at
   the untyped boundary**, and each now has a runtime code
   (`UNSOURCED_DERIVATION`, `UNSOURCED_CLAIM`, `EMPTY_REASON_LIST`,
   `CHOICE_BELOW_MINIMUM`, `SOLE_OPTION_WITHOUT_ACCOUNT`). The type keeps honest
   producers honest; the checkers are what the guarantee rests on, because they
   are what runs where the type is absent.
2. **A lone option must say why it is alone.** `OptionSet` is `choice`,
   `sole_survivor` (one option plus a non-empty account of what was excluded) or
   `only_candidate` (one option plus evidence nothing else existed). There is no
   `primary` field to read in isolation. The arities are enforced by
   `checkRecommendation`, not only by the tuple types: `minOptionsForChoice` was
   exported as data and read by nothing, so a `choice` carrying one option — the
   criterion's exact failure — passed every check.
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
| `SOURCE_UNVERIFIABLE` | an observed node has no supplied fingerprint, a node's kind is unrecognised, or the evidence graph is unreadable |
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

`isInstant(value: unknown): value is Instant` is the exported check for whether a
value is a usable instant. It is **derived from** the same `instantToMillis` the
staleness checker uses, so `isInstant(v) === (instantToMillis(v) !== null)` holds
by construction rather than by agreement — the point being that an exported
predicate is otherwise an invitation to a second spelling of the rule. A
predicate rather than the raw `RegExp`, because an exported pattern is one edit
away from a `g` flag and then `lastIndex` persists across unrelated callers, and
because `RegExp.prototype.test` coerces a number into a string instead of
rejecting it.

An `Instant` must carry an explicit offset **and name a moment that exists**.
`Date.parse` silently rolls impossible dates over rather than refusing them —
`2026-02-30T00:00:00Z` → 2026-03-02, `2026-02-29T00:00:00Z` → 2026-03-01 (2026 is
not a leap year), `2026-08-19T24:00:00Z` → the next day. An expiry written as the
30th of February and read as the 2nd of March leaves a recommendation offerable
two days past its stated life, and because the repaired value is itself a
well-formed instant no downstream check can notice. `instantToMillis` now round
trips the calendar fields through `Date.UTC`, which rolls over identically, so a
mismatch means the input named no real moment. There is no month-length or
leap-year table anywhere, and therefore no second copy of the calendar to drift.

## Repo rules this contract holds

- **No ambient clock, and no ambient time zone.** No `Date.now()`, no
  zero-argument `new Date()`, no `Math.random`, no `randomUUID`. `Date.parse` is
  the only `Date` use — but "pure function of its argument" was an over-claim
  that cost a review round: it does not read the clock, it reads the *zone*. A
  date-time with no offset is local time per the ECMAScript spec, so one
  recommendation with one `now` gave EXPIRED under `TZ=UTC`, FRESH under
  `TZ=America/Los_Angeles` and EXPIRED under `TZ=Asia/Tokyo` — the same class of
  host-dependence this contract condemns under `localeCompare`, and the source
  scan had blessed it. `instantToMillis` now requires an explicit `Z` or
  `±HH:MM` offset before parsing, and the scan asserts that fence exists rather
  than treating the parse as safe.
- **Report, never throw — four real defects, not a principle.**
  `evaluateRecommendationStaleness` raised a `TypeError` on a missing fingerprint
  map, which is the exact input the fail-closed rule exists for;
  `checkEvidenceGraph` raised on a non-string `nodeId` though `BLANK_NODE_ID`
  existed for it; `checkRecommendation` raised on an unrecognised
  `OptionSet.kind`, which is precisely the version-skew case that motivates
  running it at both ends; and `resolveEvidenceRoots` overflowed the stack at
  ~12,000 chained nodes. All four now report, and totality is a fuzzed
  property.
- **Never `localeCompare`.** This file needs no string comparator at all:
  findings are ordered by input position. `RECOMMENDATION_ORDERING_KEYS` *names*
  `lib/planning/shared/compare.ts#compareByCodePoint` for #34 rather than
  copying it, since a contract must not import `lib/`.
- **No caller-chosen identifier in a `detail` string.** Details name options and
  evidence by index and sources by kind. Enforced by fuzzing both checkers with
  ids that are themselves sensitive sentences.
- **Report, don't throw**, for everything the taxonomy names, and compute the
  input digest only *after* the structural pass.

## How the checkers are held

The checkers are the part #34 and #35 call instead of reimplementing, so their
coverage is verified by **mutation**, one site at a time — 32 single-site
mutants, each applied and reverted alone, all 32 killed by `npm run
test:sprint08`. A batch mutation proves partial coverage while looking complete,
which is why it is done singly.

Two mutants survived the first pass, and both pointed at the same real problem:
`resolveEvidenceRoots` had two guards for "this claim rests on nothing" — an
early `parents.length === 0` return and a trailing emptiness check — that
**masked each other**, so deleting either left every test green. The trailing
check was provably unreachable and is gone; one load-bearing guard means its
deletion now fails a test. That is the same finding as the provably-dead
backward-reachability pass removed from `findCyclicNodeIndices`: a second check
that reads as defence in depth is really an untested branch plus a hole in the
first check's coverage.

Exported surfaces are held against the internal ones by *behaviour*, not by
shared code: `expiryRules.test.ts` asserts `isInstant` agrees with the staleness
checker's `INVALID_INSTANT` verdict across one shared corpus of valid and invalid
instants, so a future independent re-implementation of either fails rather than
drifts. One corpus, not two — two corpora would let each side stay green about
the cases the other cares about, which is the duplication problem moved up a
level into the tests.

The fuzz generator is held the same way. Its distribution is asserted, not
assumed — it must reach every one of the eight graph defect codes, more than 60%
of accepted graphs must contain a derivation, and the deepest accepted chain must
reach 8. The previous generator could not express three codes at all, and 62% of
the graphs it accepted contained no derivation, so the property it proved held
vacuously in most of its own iterations while the iteration count looked
reassuring.

`actionKey` is total and injective over anything a boundary can hand it. It is
used for identity, so a key shared by two different unusable actions fabricates a
`DUPLICATE_OPTION_ACTION` — a checker inventing a finding, which is worse than
one missing it because the caller acts on it. Unrecognised values are encoded
with a type tag for that reason: before it, `42`/`'42'`, `true`/`'true'`,
`{}`/`[]` and `[1]`/`{ '0': 1 }` all collided.

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
