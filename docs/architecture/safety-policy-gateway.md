# Cross-module Safety policy gateway

Sprint 09, issue [#39](https://github.com/anasakkari3/maybesitter/issues/39).
Contract: `src/contracts/v1/safetyContracts.ts`. Module: `lib/safety/`.
Tests: `tests/safety/policyContract.test.ts`, `tests/safety/validators.test.ts`,
`tests/safety/redTeam.test.ts`, `tests/safety/safetyBoundaries.test.ts`
(`npm run test:sprint09`).

The gateway answers one question — **may this candidate output be shown to this
person right now** — and answers it as a *verdict*: never a thrown error, never a
silent edit. A producer says what it would like to say; the gateway says what may
leave the building, why not, and what the person is offered instead.

## The seam

The gateway is defined over **a candidate output carrying claims and evidence
references**, not over a coaching message. `lib/safety/**` imports nothing from
`lib/coaching/**` or `coachingContracts`, and
`tests/safety/safetyBoundaries.test.ts` walks the whole import closure to enforce
it.

Sprint 05's rule is that a check owned by the thing it checks is not a check. A
gateway importing the module it guards would inherit that module's idea of what a
claim is and then agree with it by construction. So the arrow runs one way:
**#38 conforms to `SafetyCandidate`**, and any producer that can describe its
output in those terms can be gated without a second gateway.

```
SafetyRequest   { requestId, surface, now, inputs[], permittedSensitivity, pressureBudget }
SafetyCandidate { candidateId, surface, segments[], claims[], evidence, effects[], pressure }
                                   │
                    evaluateSafetyGate({ request, candidate, auditId })
                                   │
             ┌─────────────────────┴─────────────────────┐
       SafetyVerdict                             SafetyAuditRecord
   allow │ allow_with_redaction │ block      (no field can hold judged text)
```

## What is reused rather than rebuilt

Sprint 08 already built an evidence graph with claim-to-source tracing, cycle
detection and root resolution. "Is this claim sourced" is that problem, so the
answer is imported:

| Sprint 08 export | Used for |
|---|---|
| `checkEvidenceGraph` | `EVIDENCE_GRAPH_MALFORMED` |
| `resolveEvidenceRoots` | `CLAIM_NOT_TRACEABLE`, `FABRICATED_INSTANT` |
| `isInstant` | `INSTANT_MALFORMED`, `EVALUATION_INSTANT_INVALID` |

`SafetyCandidate.evidence` **is** `recommendationContracts.EvidenceGraph`, not a
structurally identical local copy, and `policyContract.test.ts` pins the function
identities so a future local re-implementation fails rather than drifts.

**The one place it does not fit, stated rather than worked around.**
`CandidateClaim.supportedBy` is a plain array where Sprint 08 uses a non-empty
tuple. That is the difference between a producer's contract and a guard's: this
file *is* the untyped boundary, so an unsourced claim must be constructible in a
TypeScript red-team test. A tuple here would make the unsafe case unwritable in
the suite while remaining perfectly writable by `JSON.parse` — a check strongest
exactly where nothing attacks it. `UNSOURCED_CLAIM` is where the guarantee lives.

Two small additions were made to `safetyContracts` rather than to Sprint 08's
file: `instantsEqual` and `millisBetweenInstants`, both defined in terms of the
imported `isInstant` so that no second spelling of "what is a valid instant"
exists. `sharesTextRunWith` is exported for the same reason — the audit leak scan
and the sensitive-text scan ask one question and must not answer it twice.

## The taxonomy

24 reason codes, partitioned by **the stage that may emit them**
(`SAFETY_CODE_PARTITIONS`), the way `planningContracts` partitions static from
attempt codes: "the request is unsafe to answer" and "the answer is unsafe to
show" are different failures owned by different callers. The two halves are
disjoint and `policyContract.test.ts` asserts it.

| Stage | Codes |
|---|---|
| `pre` (request only) | `REQUEST_UNREADABLE`, `REQUEST_EXCEEDS_LIMIT`, `EVALUATION_INSTANT_INVALID`, `INJECTED_INSTRUCTION`, `UNTRUSTED_CONTENT_IN_TRUSTED_SLOT`, `SENSITIVE_SCOPE_NOT_PERMITTED`, `PRESSURE_BUDGET_EXHAUSTED` |
| `post` (candidate) | `UNKNOWN_CANDIDATE_SHAPE`, `CANDIDATE_EXCEEDS_LIMIT`, `UNSOURCED_CLAIM`, `EVIDENCE_GRAPH_MALFORMED`, `CLAIM_NOT_TRACEABLE`, `INSTANT_MALFORMED`, `FABRICATED_INSTANT`, `RAW_IDENTIFIER_DISCLOSED`, `SENSITIVE_TEXT_DISCLOSED`, `SHAMING_LANGUAGE`, `COERCIVE_PRESSURE`, `PRESSURE_INTENSITY_EXCEEDED`, `PERSISTENCE_CLAIMED`, `UNCONFIRMED_WRITE_PROPOSED`, `INSTRUCTION_ECHOED`, `DECISION_ECHO_UNATTESTED`, `DECISION_ECHO_MISMATCHED` |

An **orthogonal** classification maps every code onto a boundary
(`SAFETY_CODE_BOUNDARIES`), derived from one table rather than listed twice:
`privacy`, `harmful_pressure`, `injection`, `hallucinated_time`, `persistence` —
the five the issue names — plus `provenance` (the claim-to-evidence boundary,
where Sprint 08's graph is reused) and `integrity` (the gateway's judgement about
itself: the cases where the check cannot be performed, and a check that cannot
run is a check that refuses).

Four further total tables key off the code: `SAFETY_CODE_STAGES`,
`SAFETY_CODE_SCOPES`, `SAFETY_CODE_SEVERITY`, `SAFETY_CODE_RECOVERY`. Totality is
the mechanism, not a nicety — a new code cannot be added without every table
failing to typecheck, so no criterion below can be quietly outgrown.

## Relationship to the shipped product validators

`lib/services/responseEngine/validation.ts`, `pressureService.ts` and
`personalityService.ts` already enforce part of this at product scope. **This
module does not modify them, does not import them, and changes nothing about
their behaviour.** A merge-owned cross-track test compares the two on the same
inputs, and that comparison is only meaningful while neither can reach the other
— which is why the boundary test bans the edge in both directions.

| Product rule | Safety code | Relation |
|---|---|---|
| `SHAME_PATTERNS` (8 English adjectives, applied to a realized `ResponsePlan` message) | `SHAMING_LANGUAGE` | **Superset.** All eight spellings are carried again in `lib/safety/lexicon.ts` and `validators.test.ts` pins that each still fires, plus constructions with no forbidden word in them (`you always`, `you never`, `why can't you`). |
| `stateChange === 'none' && /saved\|created\|scheduled\|done/` | `PERSISTENCE_CLAIMED` | **Deliberately stricter.** The product fires only when a plan *declares* `stateChange: 'none'`; a plan that omits the field reaches none of those branches. The gateway guards modules that propose, so the trigger is the claim itself. Deliberately **narrower** on the lexicon: the product's `CREATION_OR_TRACKING_CLAIM` matches bare `reminder`, which would make "shall I set a reminder?" a persistence claim. |
| `PRESSURE_DELIVERY_COOLDOWN_MS` (1 hour, per commitment, via a delivery store and an ambient `now`) | `PRESSURE_BUDGET_EXHAUSTED` | **Same rule at module scope.** The interval is an *input* here, so this contract holds no second copy of the product's number. Adds a consecutive-unanswered ceiling, which a cooldown has no shape for: a cooldown alone permits an unbounded run of hourly nudges to someone who has answered none of them. |
| `LEGACY_AND_INTERNAL_PATTERNS` ISO-date ban in user copy | `FABRICATED_INSTANT` | **Deliberately different.** That is a presentation rule about how a time may be *written*; this is a provenance rule about whether it was *read*. Neither implies the other, and the cross-track test should expect disagreement in both directions rather than treat it as a defect. |
| `strategyAlignmentErrors` (a pressure message must match its strategy) | `COERCIVE_PRESSURE` | **New ground.** The product checks alignment, never permissibility: a perfectly aligned `escalate_choice` reading "do it now or I stop helping you" passes every product check there is. |
| `STATE_WRITE_POLICY` | `UNCONFIRMED_WRITE_PROPOSED` | **Same rule, made observable.** The policy said modules may not write canonical state; this is the code that observes one trying. |
| `personalityService` filler / system-like filters | — | Not covered. Those are tone and register rules at product scope; the gateway has no opinion about them. |

## How each acceptance criterion is met

**Fail-closed behaviour is scoped and recoverable.** Failing closed is the safe
direction; failing closed *forever* is a denial of service with a safety
justification. Every code carries a `SafetyBlockScope` in `SAFETY_CODE_SCOPES`;
there is no `session` or `user` member, and `policyContract.test.ts` asserts no
code reaches past `surface`. Exactly one code is `surface`-scoped —
`PRESSURE_BUDGET_EXHAUSTED`, the only condition rebuilding cannot fix and waiting
can — and its `SafeUserPath` carries a `retryAfter` derived from the request's own
`now` and the caller's own interval.

**Sensitive raw text is not logged.** `SafetyAuditRecord` has **no field of any
type** that can hold candidate or input text, so the only surface a leak can reach
is a finding `detail` — which is where Sprint 07's real leak went, reading
`working window call-dr.cohen-about-the-biopsy` past a test that checked only that
the title was absent. Every locator on `SafetyFinding` is therefore an **index**
into an input array, never an identifier. `checkSafetyAudit` scans details for
both caller-chosen identifiers and runs of judged text, and `redTeam.test.ts`
additionally serialises the whole verdict and audit record and looks for every
string each attack was built from.

This rule bit during development, correctly: the first `INJECTED_INSTRUCTION`
detail read "…addressed to the system rather than to a person" and tripped
`AUDIT_CONTAINS_RAW_TEXT`, because the payload it was describing also contained
"the system". The scanner was right; the prose was reworded. Loosening the
scanner would have been the comfortable fix and would have blinded it for every
finding.

**All blocked actions give a safe user path.** `SafetyVerdict` is a three-variant
union and both withholding variants *require* a `SafeUserPath`, so a refusal
cannot be rendered without its way out. `SAFETY_CODE_RECOVERY` is total over the
vocabulary, and `policyContract.test.ts` also asserts the reverse — that every
path kind is reachable from some code, so no recovery copy exists that a user can
never be shown. `redTeam.test.ts` asserts it over the whole attack corpus.

**Tests, documentation, migration/rollback notes.** This file, plus the four
suites and the notes below.

## Decision echoes — a cross-track ruling with #38

#38 produces claims about the **user's own act** ("you marked that done"), whose
truth condition is a decision record rather than an evidence node. Its first
proposal was to exclude them from `SafetyCandidate.claims` entirely, and its
reasoning was sound as far as it went: converting them with `supportedBy: []`
would fire `UNSOURCED_CLAIM` — blocking severity — on every honest
acknowledgement the module produces, and attaching the accepted option's evidence
instead would make a *fabricated* completion look sourced, which is worse than
the gap.

**Ruled in scope.** Excluding them would leave the sharpest thing the coaching
module can emit checked by the coaching module alone — and this gateway's entire
justification for refusing to import `lib/coaching/**` is Sprint 05's rule that a
check owned by the thing it checks is not a check. Accepting the exclusion would
have been the gateway applying that rule to everyone except the one claim class
where it matters most.

The reason the class *looked* uncheckable was not that its truth condition is
unknowable; it was that `SafetyRequest` did not carry the record. That is a gap
in this contract, not a fact about the world. So:

- `SafetyRequest.attestedDecisions: readonly RecommendationDecision[]` — Sprint
  08's shape, **imported rather than restated**. A second decision record here
  would be two copies of one dataset, and the failure would be specific: the
  verdict vocabularies would diverge and `DECISION_ECHO_MISMATCHED` would report
  a disagreement between two spellings rather than a fabrication.
- `CandidateClaimKind` gains `decision_echo`; `CandidateClaim` gains
  `decisionIndex` (a **position** into `attestedDecisions`, never an id) and
  `echoedVerdict` (the act the prose attributes to the person).
- `DECISION_ECHO_UNATTESTED` and `DECISION_ECHO_MISMATCHED`, both `provenance`,
  both blocking. Citing nothing and citing something that says otherwise are
  different mistakes by different producers — the distinction
  `recommendationContracts` draws between `UNSOURCED_CLAIM` and
  `UNKNOWN_EVIDENCE_NODE`.

This is **not** a duplicate of #38's `DECISION_CLAIM_WITHOUT_DECISION` /
`DECISION_CLAIM_VERDICT_MISMATCH`. Sprint 06's lesson distinguishes the two
cases: two independent implementations of a *judgement* check each other, and
that is what the cross-track test is for; two copies of *data* are a gap. Here
the judgement is deliberately made twice and the data is single-sourced.

Three further notes:

- The fields are **required-and-nullable, not optional**. An optional field is
  one a producer omits without the compiler saying anything, and the point of the
  change is that #38's decision-echo-dropping conversion must stop compiling
  until it is adjudicated. The compiler is the notification mechanism.
- The exemption from `UNSOURCED_CLAIM` is narrow and tested in **both**
  directions: every other kind with empty `supportedBy` still reports
  `UNSOURCED_CLAIM`, and a `decision_echo` naming nothing still reports
  `DECISION_ECHO_UNATTESTED`. Sprint 08 recorded what an exemption becomes when
  nothing stops it widening.
- **The limit of the check, not oversold.** The gateway compares what a producer
  *says* against what the request *attests*; a caller that forges the record
  defeats it. That is true of every check here — `valueFingerprint` is supplied
  by whoever read it, `sensitivity` is declared rather than inferred, the
  pressure budget is the caller's — and it is still a real check, because the
  realizer that writes the prose and the store that writes the decision are
  different places. A fabrication by the realizer is caught; a compromised caller
  is not, and a compromised caller defeats everything.

`checkRecommendationDecision` is deliberately **not** used: it judges a decision
against the offer it targets, and the gateway holds no offer. Reaching for it
would mean inventing an offer to satisfy a signature, which is how a check starts
measuring its own fixture.

`attestedDecisions` carries no bound in `SAFETY_LIMITS` because the validator
indexes into it and never iterates it, so its length cannot make any pass more
than constant-time. A bound declared here would be one nothing enforces — the
exact shape Sprint 08 paid 8.2 seconds of CPU for.

## Limits

`SAFETY_LIMITS` is one frozen object; `SafetyLimitName` is derived from its keys;
`SAFETY_LIMIT_STAGES` says which side of the seam owns each bound; and
`validators.test.ts` iterates `Object.keys(SAFETY_LIMITS)` and demands a finding
naming each one. Scanning **stops** at each bound rather than reporting the excess
and continuing — that is what makes the bound load-bearing.

Sprint 08 shipped `maxEvidenceRefsPerReason` declared beside enforced limits and
enforced nowhere, and a valid request then burned 8.2 seconds of CPU on an
unauthenticated route and returned 200. `redTeam.test.ts` carries that exact
shape — one claim citing the same node 400,000 times — plus a maximal hostile
input judged under a wall-clock bound, and a 20,000-node derivation chain that
must be refused rather than overflow the stack.

## Three duplications removed, one of them found by this change

`lib/safety/postValidator.ts` held private copies of `CANDIDATE_CLAIM_KINDS` and
`PROPOSED_EFFECT_KINDS`. Adding `decision_echo` to the contract left the private
copy behind, so the new kind would have been reported `UNKNOWN_CANDIDATE_SHAPE`
by the very validator meant to check it. Both now import from the contract. The
copies were four days old and had already diverged once — Sprint 06's lesson
verbatim: two copies of one datum do not check each other, they wait for one of
them to be edited.

`SEGMENT_ROLES` is still local, because the contract does not export it as data.
Named here so the asymmetry is a decision rather than an oversight; exporting it
belongs with the next change that touches `CandidateSegment`.

## Two fail-open defects the red-team suite found

Recorded because both had the same shape and neither was visible to any
assertion about the thing itself: a single "unknown ranks highest" helper used on
*both* sides of a comparison.

- `permittedSensitivity` with an unrecognised class ranked as permitting
  everything, so a misspelled or newly-added class would have opened the privacy
  boundary completely, on every surface at once.
- `pressureBudget.maxIntensity` absent — what a caller that half-built a budget
  object actually sends — read as permitting the hardest push available.

The fix is that the two sides rank an unknown value in **opposite** directions:
unknown *content* is the most exposed, unknown *clearance* is the least
permissive. Both now have named regression tests.

## Migration

There is nothing to migrate. The gateway is additive and unrouted:

- no stored data is written or read, and no schema, file or database changes;
- no existing route, component, service or test imports `lib/safety/**`;
- `lib/services/**` is untouched, so the shipped response, pressure and
  personality behaviour is byte-identical;
- `INTELLIGENCE_MODULES` already contained `safety`, so no audit event name,
  kill switch or runtime control changes. Only the descriptor's `execute` output
  moved from `{ status: 'not_implemented_in_sprint_00' }` to the `implemented`
  shape naming `lib/safety#evaluateSafetyGate`.

A consumer adopts the gateway by building a `SafetyRequest` and a
`SafetyCandidate` and calling `evaluateSafetyGate`. Until one does, the module is
exercised only by its own suites.

## Rollback

`git revert` of the sprint merge, or of this branch alone. Nothing persists
across it:

- no stored data is written or read, so there is no data migration to reverse;
- reverting the `safety` descriptor in `moduleContracts.ts` returns it to the
  placeholder shape, and the matching pin in
  `tests/contract/intelligenceModuleBoundaries.test.ts` must be reverted with it
  — those two changes are a pair and a revert of one alone fails
  `npm run test:contracts`;
- reverting `package.json` removes the twelve Sprint 09 registrations. `node
  --test` silently skips a missing file among present ones and exits 0, so the
  registrations are safe to land ahead of the files, but a partial revert that
  removed **every** named file while leaving the registrations would make the
  runner error rather than skip.

The one ordering constraint is that #38 conforms to `safetyContracts`, so a
revert of this branch alone requires reverting #38 first.

## Known gaps

- **Sensitivity is declared, never inferred.** The gateway reads
  `UntrustedInput.sensitivity` and does not classify text. That is deliberate — a
  content classifier wrong in the permissive direction is a privacy leak that
  reports as a pass — but it means a caller that mislabels a span gets no
  protection from this boundary.
- **Identifier scanning has a floor** of four characters
  (`MIN_IDENTIFIER_MATCH_LENGTH`), because a two-character id is a substring of
  ordinary English and scanning for one reports every message as a leak. A leak
  of a three-character id is not caught by that scan. It is the second line of
  defence; the structural rule — identifiers never enter prose at all — is the
  first.
- **The shame and coercion lexicons are English-first.** The injection patterns
  cover AR/HE/EN; the pressure lexicons do not, and a shaming Arabic or Hebrew
  message would pass `SHAMING_LANGUAGE` today. #37's evaluation set is where the
  multilingual corpus belongs, and the gap is named here rather than papered over.
- **No caller yet.** The module is unrouted, so every claim above rests on its
  suites rather than on production traffic.
