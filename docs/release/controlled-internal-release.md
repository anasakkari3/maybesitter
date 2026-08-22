# Controlled internal release — cohort, consent, staged exposure and the decision package

Sprint 11, issue #47. Everything below is **shipped infrastructure**. No cohort
has been exposed, no feedback has been collected, and no release decision has
been taken. This document says exactly which of those statements the code
enforces and which are simply true today.

---

## 1. What this issue built, and what it deliberately did not

**Built and wired:**

| Deliverable | Where |
| --- | --- |
| Study consent: grant, revoke, delete | `lib/release/consentStore.ts` |
| Staged exposure configuration and gate | `lib/release/exposure.ts` |
| Feedback-study data model, parsing, summary | `lib/release/study.ts`, `lib/release/studyStore.ts` |
| Deletion and its verifiable receipt | `lib/release/deletion.ts` |
| Go / hold / rollback evidence package | `lib/release/evidence.ts` |
| Collection API | `lib/release/handler.ts`, `src/app/api/release/route.ts` |

**Not built, on purpose:** actually exposing the pipeline to a consented
internal cohort and collecting live feedback. That is a business action, not an
implementation pass. The generator is pointable at real data the day it exists;
nothing in it is fixture-specific.

---

## 2. No general release occurs in this issue

This is enforced three ways, not asserted once.

1. `ShadowExposureStage` has **no general-availability member**. There are three
   stages — `shadow_only`, `internal_dogfood`, `closed_pilot` — and no fourth to
   configure. A general release is not something this code refuses; it is
   something it cannot express.
2. Every stage's cap is at or below `CLOSED_PILOT_MAXIMUM` (40), pinned against
   `lib/pilot/closedPilotControls` by test.
3. `readStageConfiguration` is **fail-closed**: an unset or unrecognised
   `MAYBESITTER_SHADOW_STAGE` reads as `shadow_only`, whose cap is zero. A typo
   in a deployment variable cannot widen exposure.

The default deployed configuration is `shadow_only` with an empty cohort. That
is the stage this sprint ships in.

### Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `MAYBESITTER_SHADOW_STAGE` | `shadow_only` \| `internal_dogfood` \| `closed_pilot` | `shadow_only` |
| `MAYBESITTER_SHADOW_COHORT_IDS` | Comma-separated participant ids | empty |

| Stage | Floor | Cap | Restates |
| --- | --- | --- | --- |
| `shadow_only` | 0 | 0 | — the chain runs, nobody is exposed |
| `internal_dogfood` | 1 | 10 | `ALPHA_ALLOWLIST_MINIMUM` / `_MAXIMUM` |
| `closed_pilot` | 25 | 40 | `CLOSED_PILOT_MINIMUM` / `_MAXIMUM` |

The floor matters as much as the cap: a "closed pilot" of four people produces
evidence nobody should decide on, and `checkStageConfiguration` reports it.

### The gate can only narrow

`resolveStagedExposure` consults `resolvePilotAccess` **first** and its refusal
is final. Then the stage, then consent, then the cap, then the stage cohort.
There is no path in `lib/release` that turns a pilot refusal into an exposure.
Every one of the eight `ShadowPilotStopReason`s is swept by test, and each is
carried through verbatim rather than remapped — a participant refused for
`quiet_mode` sees `quiet_mode`, because a second vocabulary saying
`not_eligible` for all eight is how a support conversation becomes unanswerable.

---

## 3. Consent, opt-out and delete

Consent is **opt-in, scoped and revocable**. Three separately refusable scopes:

- `shadow_execution` — may the chain run for this person's scope
- `feedback_study` — may we ask them questions
- `trace_retention` — may their traces be kept (#46's dependency, and the one
  most likely to be revoked alone)

The default, absent an explicit grant, is `withheld`. Revocation is a *shape*:
`ShadowRevokedConsent` carries `scopes: readonly []` in the type, and the store
drops scopes on the way out of any non-granted record — so there is no field a
consumer can read a live scope off once consent is gone.

**Opting out lands on the next read.** Nothing caches an exposure decision:
`resolveStagedExposure` re-reads the consent store on every call. A revoke
response also carries the rebuilt exposure decision, so a client cannot display
a live exposure beside a withdrawn consent.

### Deletion, and what the receipt proves

`deleteShadowStudyParticipant` purges consent, study responses, shadow traces,
replay bundles and the personalization scope (via Sprint 10's
`deletePersonalizationScope`, embedded whole rather than re-implemented).

Every remainder on the receipt is **re-listed from the store after the deletes**,
never subtracted from what a `deleteParticipant` claimed to remove. The one
failure a deletion receipt exists to catch is a delete that reports a count and
leaves rows behind, and a receipt built from the delete call's own return value
cannot catch it.

`emptyStateDigest` is recomputable independently through the exported
`shadowEmptyStateDigest(participantId, deletedAt)`. Its limitation is stated in
the module header and repeated here: it is a pure function of the participant
and the instant and would hold even if the deletion did nothing. It binds the
receipt to *this* person and *this* moment, so one person's receipt cannot
verify another's deletion. The load-bearing proof of emptiness is the remainder
counts.

**Today the API returns `deleted_unproven` for every delete.** The data is
deleted; what cannot be produced is a proof that no shadow traces remain,
because #45's trace store does not exist. See §6.

---

## 4. The feedback study

Five questions, closed vocabulary: `helpfulness`, `accuracy`, `intrusiveness`,
`trust`, `would_use_again`. `intrusiveness` is the cost question and is read in
the opposite direction to the others — a product measuring only helpfulness
learns to be louder.

A rating is a whole number in 1–5. **A declined answer is a row, not a missing
row.** Folding declines into "no data" loses the only signal a study gets about
questions people will not answer, and makes "nobody was asked" and "everybody
refused" the same number.

An answer's identity is the `(participant, run, question)` triple: re-answering
supersedes rather than appends, so somebody who tapped twice counts once.
`respondedAt` is the request's instant, never the client's — a study whose
timestamps the respondent chooses cannot be ordered against the runs it is
about.

`summarizeStudyResponses` reports `meanRating: null`, never `0`, for a question
nobody rated. Rendering "we have no ratings" as zero puts the worst possible
score on exactly the question people would not answer.

---

## 5. The go / hold / rollback evidence package

### Three pillars, or the package does not exist

`ShadowEvidencePackage.evidence` is a total record over `quality | safety |
reliability`, each a non-empty tuple. A package missing a pillar does not
compile. When a pillar's input is not wired, the generator emits an item that
**says so** — `support: 'inconclusive'`, citation `not_available.<owner>` — so a
missing input is a visible finding rather than a silently absent pillar.

### The engagement rule is structural

`NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE` (#41's invariant, the same string via
`SHADOW_RELEASE_GATE_INVARIANT`) is enforced by the *shape of the input*:

- A `ShadowPillarFinding` — the only input that carries a disposition, and so
  the only input that can become a `go` — has `measureClass` typed as
  `ShadowMeasureClass` **minus** `SHADOW_ENGAGEMENT_MEASURE_CLASSES`. An
  engagement finding does not typecheck.
- A `ShadowEngagementObservation` has no disposition field at all and always
  becomes `support: 'inconclusive'`.

So a `go` derivable from engagement alone is not refused — it is
unrepresentable. Engagement measures still appear in the package, as context,
where they are visible to a reader and to `GO_RESTS_ON_ENGAGEMENT_ALONE`.

### The decision, and its asymmetries

```
any item supports rollback        → rollback
else any item supports hold       → hold
else every pillar supports go     → go
else                              → hold
```

There is no branch comparing a count of benefits against a count of harms.

1. **Any harm alone refuses.** One harm in any pillar rolls back, beside any
   number of benefits. A gate that can be outvoted by a benefit ships harm once
   the benefit number is large enough.
2. **A concern holds.** `hold` is the honest default and the commonest answer.
3. **Evidence not from real exposure can refuse and can never authorise.** A
   `benefit` whose provenance is not `real_exposure` is emitted as
   `inconclusive`; a `harm` from the same source is emitted as `rollback`.
   Simulation can falsify, it cannot authorise. This is `evaluateRollbackGate`'s
   own asymmetry, and the reason Sprint 04's empty corpus and Sprint 06's
   synthetic dataset both became "our results" the moment somebody quoted a
   number.
4. **An inconclusive SLO reading cannot carry a `go`.** "We could not measure
   it" is not "it is fine".

### Where the study's thresholds come from

`SHADOW_STUDY_EVIDENCE_POLICY` invents no numbers:

- `neutralRating` is the midpoint of `SHADOW_STUDY_RATING_SCALE` (3). A scale's
  own middle is the one non-arbitrary place to put the line.
- `minimumRespondents` is `MIN_SLO_SAMPLE_COUNT` (20), the smallest sample any
  contract in this repo will call a measurement. It is deliberately strict for a
  25–40 person pilot: below it every question reads inconclusive, so a small
  study can neither raise a false alarm nor authorise a release. **This is the
  one number a reviewer should push back on if they disagree** — it is a reuse,
  not a derivation, and it is named in one place.

---

## 6. What the package can and cannot assemble today

| Pillar | Wired to | State today |
| --- | --- | --- |
| quality | this sprint's study responses (`qualityPillarFromStudy`); #43's `evaluateRollbackGate` (`qualityPillarFromEvaluationReport`) | Wired in the route to the study. Zero responses today → every question inconclusive → `hold`. |
| safety | `safetyPillarFromObservations`, a typed seam for #45's traces | `unavailablePillarSource('issue_45_shadow_traces')` |
| reliability | `reliabilityPillarFromSloReadings`, a typed seam for #46's readings | `unavailablePillarSource('issue_46_slo_readings')` |

The deployed endpoint therefore always decides `hold`, and says in the package
which two pillars it could not measure. That is the true state of this build.

---

## 7. Integration notes

Four one-line changes, all in `src/app/api/release/route.ts`:

1. `traces: notWiredArchive('issue_45_shadow_trace_store')` →
   `wiredArchive(#45's trace store)`. Deletes then return a full receipt instead
   of `deleted_unproven`.
2. `replayBundles: notWiredArchive('issue_45_replay_bundle_store')` →
   `wiredArchive(#45's replay store)`.
3. `safety: unavailablePillarSource(...)` →
   `safetyPillarFromObservations(#45's counts, 'real_exposure')`.
4. `reliability: unavailablePillarSource(...)` →
   `reliabilityPillarFromSloReadings(#46's readings, 'real_exposure')`.

`qualityPillarFromEvaluationReport` is ready for #43's report and is exercised
by test; wire it with `mergePillarSources` beside the study source when a cohort
report exists.

---

## 8. Migration and rollback notes

**Migration.** There is none to run. Two new store directories appear under
`MAYBESITTER_DATA_DIR` on first write:

- `shadow-study-consent/` — one `*.study-consent.json` per participant,
  mode 0600, filename a sha256 of the participant id
- `shadow-study-responses/` — one `*.study-responses.json` per participant, same
  conventions

Both are written temp-then-rename. Absent files read as the fail-closed default
(`withheld` / no responses), so a fresh deployment behaves exactly like one
whose stores were deleted. No existing store's schema changes, and no existing
route changes.

**Rollback of this feature.** Remove `MAYBESITTER_SHADOW_STAGE` and
`MAYBESITTER_SHADOW_COHORT_IDS` (or set the stage to `shadow_only`); exposure
returns to zero on the next request, with no restart and no cache to clear.
Deleting the two store directories is safe and returns every participant to
`withheld` — which is the same thing as opting everybody out. `/api/release` may
be removed wholesale without touching any other route: nothing else imports
`lib/release`.

**Rolling back an exposure, mid-study.** Three independent levers, narrowest
first:

1. Remove a participant from `MAYBESITTER_SHADOW_COHORT_IDS` — refuses that one
   person on their next read.
2. Set `MAYBESITTER_SHADOW_STAGE=shadow_only` — refuses everybody, immediately.
3. The pilot kill switch (`runtimeControls.killSwitches.recommendation`) — the
   pilot gate refuses first, and its refusal is final here, so this also stops
   shadow exposure. It is the widest lever and it is not owned by this issue.

None of the three deletes anything. Deletion is a separate, explicit verb.

---

## 9. Tests

`npm run test:sprint11` covers `tests/release/**` plus the shadow contract
tests. The acceptance criteria map to:

| Criterion | Test |
| --- | --- |
| No general release occurs | `exposure.test.ts` — "the stage vocabulary has no general-release member…", "no configuration of any stage can expose more people than the closed pilot admits" |
| Users can opt out | `exposure.test.ts` — "opting out takes effect on the very next read, with no exposure surviving it"; `handler.test.ts` — "opting out lands on the next exposure read" |
| Users can delete data | `deletion.test.ts` — "the receipt is verified by re-listing every store, not by trusting its counts"; `handler.test.ts` — "a complete delete returns a receipt, and the stores agree when asked again" |
| Decision includes quality, safety and reliability evidence | `evidence.test.ts` — "a package always carries every pillar…", "an unavailable pillar is an honest 'not available' item, never a missing pillar" |


## Precondition: this endpoint has no authentication

`/api/release` reads `participantId` from the request body and verifies no
credential, so any caller who can reach it can read or delete any participant's
consent record and study answers. The repo has no session layer for any route to
use; this is the first surface where that gap has a multi-occupant namespace
behind it — a closed pilot admits 25 to 40 people, and the data behind an id is
their consent and their answers.

**Do not expose this endpoint beyond a trusted network until a session layer
exists.** Staged exposure, caps and consent all work as specified; none of them
is an access control, and none of them was designed to be one.
