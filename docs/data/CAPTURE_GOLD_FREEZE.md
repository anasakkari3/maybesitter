# Capture Gold freeze and annotation governance

How reviewed Capture Gold is pinned, how a disagreement is resolved without
rewriting a human decision, and what has to happen before any of it can train a
model.

Sprint 01 · issue [#5](https://github.com/anasakkari3/maybesitter/issues/5).
The failure this closes is written up in
[the root-cause report](CALIBRATION_CONSISTENCY_ROOT_CAUSE.md).

## Where things live

| Path | What it is |
| --- | --- |
| `lib/calibration/contracts.ts` | Versioned contracts: annotation policy, adjudication, gate report, freeze manifest. |
| `lib/calibration/policy.ts` | Policy-registry rules and supersession-chain walking. |
| `lib/calibration/adjudication.ts` | Adjudication rules, including the check that a `policy_shift` claim is supported by an actual policy change. |
| `lib/calibration/consistency.ts` | Decision pairing and policy-normalized agreement. |
| `lib/calibration/perItemAgreement.ts` | Boundary, count, slot, and date-time agreement, read from per-item Gold. |
| `lib/calibration/gate.ts` | Thresholds, gate evaluation, and what a given status authorizes. |
| `lib/calibration/goldFreeze.ts` | Freeze construction and verification. |
| `data/calibration/annotation-policy.json` | Versioned annotation policy. |
| `data/calibration/adjudications.jsonl` | Append-only disagreement resolutions. |
| `data/calibration/consistency-gate-report.json` | The gate run that authorized the freeze. |
| `data/calibration/capture-gold-freeze.json` | The freeze manifest. |

## Commands

```bash
npm run test:calibration

node --loader ./scripts/ts-resolver.mjs scripts/calibration-consistency.mjs \
  --calibration-root ../maybesitter-gemma-gold-calibration \
  --out data/calibration/consistency-gate-report.json

node --loader ./scripts/ts-resolver.mjs scripts/freeze-capture-gold.mjs \
  --calibration-root ../maybesitter-gemma-gold-calibration [--check]
```

The calibration data lives in the Gemma pipeline working copy, not here, so
`--calibration-root` is required. Both scripts are idempotent: an existing
output's `createdAt` / `frozenAt` is reused, so re-running does not change bytes
just because the clock moved. That matters because both outputs are registered
as **locked** artifacts.

`--check` verifies an existing freeze without writing. It is the command to run
in review.

## Human decisions are never rewritten

This is the constraint everything else is shaped around.

`data/review/gold-decisions.jsonl` and `data/review/per-item-gold.jsonl` are the
reviewer's own records. Nothing in this repository writes to them. Both are
append-only in the Gemma working copy, and a later line for the same source is
the canonical one.

Resolution happens in a **separate, additive layer**. An adjudication records
which pass is canonical, under which policy version, and why — leaving both
original decisions intact and readable. Anyone can reconstruct what the reviewer
actually said at each pass and what a later judgement did with it.

The freeze manifest is likewise a **pointer structure**. It stores a sha256 of
each canonical decision line, not the line itself. It carries no completion text
and no reviewer identity, which is also why it is safe to hold in this
repository while the underlying records stay internal-only.

Verification runs both directions:

- editing a frozen human decision is caught by `FRZ051`
- deleting one is caught by `FRZ050`
- editing the manifest after sealing is caught by `FRZ033`, because
  `recordsChecksum` covers the canonical JSON of the records it claims

### Which decision governs

Each frozen record carries two decision fields, and the distinction matters:

| Field | Meaning |
| --- | --- |
| `firstPassDecision` | What the canonical decisions file says. For an adjudicated source this is **not** the decision in force. |
| `canonicalDecision` | The decision that governs, resolved from `canonicalPass`. **This is the field consumers read.** |

For the two adjudicated sources, `firstPassDecision` is `accepted` while
`canonicalDecision` is `rejected`. A consumer that read the first field would
train on the label the adjudication overrode — the reason the fields are named
apart rather than one field meaning different things in different rows.

Validation keeps them honest: `FRZ036` rejects a record whose `canonicalPass` is
`first` but whose two decisions disagree, and `FRZ029` / `FRZ034` require that a
record with no canonical pass carries no decision and is excluded. Building a
freeze that adjudicates to the second pass without supplying the second-pass
decisions throws rather than guessing.

## Annotation policy versioning

A policy version names the rules it changed against the version it supersedes,
and which review dimensions each rule can move:

```json
{
  "ruleId": "MULTI-001",
  "kind": "changed",
  "statement": "A source containing more than one commitment may not be accepted as a single combined completion.",
  "affects": ["decision", "commitment_count", "boundary"]
}
```

`affects` is not decoration. It is what lets an adjudicator say "this
disagreement is a guideline change, not reviewer noise" and be checked on it: a
`policy_shift` claim is rejected (`ADJ043`) unless some rule change between the
two passes' policy versions declares that it affects the claimed dimension.

Published versions are never edited — a new version is appended. Exactly one
version may be the root (`POL027`), and the chain is walked, not assumed.

Current chain: **1.0.0** (overall completion) → **2.0.0** (per-item separation,
the change that happened mid-round) → **2.1.0** (this issue's corrections:
TIME-001, TIME-002, EDIT-001, CAT-001).

## Adjudication

One adjudication per **source and dimension**. A source can disagree for
different reasons at different levels, and `pilot-v4-review-hebrew-039` did: its
decision flipped because of a guideline change, while its per-item date-time
differed because of a tooling defect. One verdict per source would have blamed
one cause for both.

Each record requires a rationale (`ADJ017`), the authorizing issue (`ADJ020`),
the policy version each pass ran under, and an explicit `requiresReannotation`.
A `tooling_defect` must name the defect it blames (`ADJ031`). An adjudication
cannot be written for an item that agreed (`ADJ032`).

Classification drives the arithmetic:

| Class | Effect on the reliability metric |
| --- | --- |
| `agreement` | counted as a match — not a valid adjudication outcome (`ADJ030`) |
| `reviewer_noise` | stays in the denominator; lowers the rate |
| `policy_shift` | **excluded** from numerator and denominator |
| `tooling_defect` | **excluded**, and its comparisons reported separately |

Excluding rather than crediting is deliberate. A disagreement produced under two
different rule sets is evidence of neither reliability nor unreliability.
Counting it as agreement would inflate the number.

## The consistency gate

Thresholds are in `DEFAULT_GATE_THRESHOLDS`:

| Threshold | Value | Why |
| --- | --- | --- |
| `minPolicyNormalizedDecisionAgreement` | 0.85 | Conventional substantial-agreement bar, on a deliberately hard stratified sample. |
| `minPerItemAgreement` | 0.85 | Same bar for boundary, count, slot, and date-time. |
| `underpoweredBelowComparisons` | 30 | Below this a single item moves the rate more than three points, so any pass is provisional. |
| `requireEveryDisagreementAdjudicated` | true | An unexplained disagreement fails the gate. |

Three statuses:

- **`pass`** — every threshold met, every dimension measurable and adequately
  powered, no outstanding provisos.
- **`pass_provisional`** — thresholds met, but something is recorded against it:
  an underpowered dimension, an excluded defect, an item awaiting re-annotation.
- **`fail`** — a threshold missed, a dimension unmeasurable, or a disagreement
  unadjudicated.

An **unmeasurable dimension is a failure**, not a `null`. That is the specific
defect (CAL-001) that let the original multi-commitment gate fail open for the
entire round.

What a status authorizes:

```ts
gateAuthorizesFreeze(report)    // pass OR pass_provisional
gateAuthorizesTraining(report)  // pass only
```

Freezing evidence under a recorded caveat is reasonable. Training on it is not.
Issue #5 forbids training regardless, but encoding the distinction means the
rule outlives the issue.

## Freeze procedure

1. Run the consistency gate. If it fails, fix the cause — do not lower the bar.
2. Adjudicate every disagreement. Each needs a rationale and an authorizing
   issue.
3. Build the freeze. `buildGoldFreezeManifest` throws if the gate does not
   authorize one.
4. Sources with any dimension marked `requiresReannotation` are **excluded**
   automatically, with the reason recorded. Known-bad Gold is never frozen as if
   it were good.
5. Register the manifest and the gate report in the dataset registry as
   **locked** artifacts, append their lock-ledger rows, and reseal
   (`npm run seal:ledger`). See
   [the registry docs](DATASET_REGISTRY.md#change-procedure-for-a-locked-artifact).
6. Verify: `scripts/freeze-capture-gold.mjs --check` and
   `npm run validate:registry -- --verify maybesitter=.`

### Changing a freeze

A freeze is a locked artifact. It is not edited — it is superseded, exactly like
any other locked artifact: build `capture-gold-freeze-v2` under a new id, set v1
to `state: "superseded"` with `supersededBy`, retire v1's ledger row with a
supersession reason, append v2's row, and reseal.

`FRZ013` and `FRZ014` enforce that an active freeze claims no successor and a
superseded one names its own.

## Current freeze

```text
capture-gold-freeze-v1  ·  policy 2.1.0  ·  gate capture-gold-consistency-v2 (pass_provisional)
50 records · 49 included · 1 excluded
records checksum 7f30a551b0ad07348ef76384439d428063d59d404c2ed0b17fb53368dfe1bc5c
```

Excluded: `pilot-v4-review-hebrew-039` — date-time defect CAL-002 requires
re-annotation. Both of its per-item annotations are unusable: the first carries
an invented timestamp, the second corrects it by discarding a date the source
actually stated.

Two sources take their canonical decision from the **second** pass
(`pilot-v4-review-hebrew-039`, `pilot-v4-review-ambiguous-029`), because the
second pass applied policy 2.0.0's separation rule and the first could not. All
other 48 stay on the first pass.

## Migration notes

### From `consistency_review.py report`

`scripts/gemma-calibration/consistency_review.py` is left in place and
unmodified. Its `prepare` command — which selects the blind sample without
leaking prior decisions — is still correct and still the way to draw a blind set.

Its `report` command is superseded by `scripts/calibration-consistency.mjs`.
Differences a reader should know about:

- boundary and commitment-count agreement are read from
  `data/review/per-item-gold.jsonl`, not from non-existent completion fields
- `fieldLevelAgreement` is split into `slots` and `date_time`, because a slot
  disagreement and a temporal disagreement have different causes and different
  fixes
- every rate carries a Wilson interval and an `underpowered` flag
- disagreements are classified, and policy shifts are excluded from the
  reliability metric rather than charged to the reviewer
- an unmeasurable dimension fails instead of reporting `null`

The old report format had no `status` field; consumers looking for a pass/fail
signal should read `status` from the new report.

### For the pilot-v4 staged compiler

`scripts/gemma-calibration/staged_gold_compiler.py` is **not modified by this
issue**. It still reports
`blockedReason: "calibration_consistency_not_completed"` and
`trainingReady: false`, which is correct: this issue explicitly does not start
training, and the gate is provisional.

When the compiler is updated (a separate change), it should read
`data/calibration/capture-gold-freeze.json` and use only records where
`excluded` is false, and it should require gate `status === "pass"` — not
`pass_provisional` — before setting `trainingReady`.

### Per-item schema 1.1.0 and the annotation tooling

Both shipped, in the Gemma working copy, after the freeze was taken:

**`per-item-gold.schema.json` 1.1.0** makes `localTimeSpec.time` nullable, so a
date-only "tomorrow" / "מחר" / "بكرة" is expressible without inventing a clock
time or dropping the date. It also adds `annotatedAt`, required for 1.1.0
records. Records written under 1.0.0 stay valid and are **not** rewritten;
`SUPPORTED_SCHEMA_VERSIONS` accepts both and the required-field set is chosen per
version.

**`remediation.py`** gains `validate_temporal_resolution`, implementing rules
TIME-001 and TIME-002. It rejects a value that resolves before the record's
`reference_time`, and a value sitting within a day of the annotation instant
while being much further than that from `reference_time` — the fingerprint of a
picker that defaulted to "now".

`annotatedAt` is what makes that second check possible. Without it there is no
way to distinguish a correctly resolved value from a defaulted one, which is
exactly how CAL-002 survived review. A 1.0.0 record therefore reports
**unauditable** rather than passing:

```text
items[1].target.dueAt cannot be checked against rule TIME-001: this record
carries no annotatedAt, so there is no way to tell a resolved value from the
annotation session's clock. Re-annotate under schema 1.1.0.
```

Running that audit over the nine existing per-item records flags exactly one —
`pilot-v4-review-hebrew-039`, the known-bad record. The other eight carry no
temporal values at all, so there is nothing to check.

**`remediation_dashboard.py`** now records `annotatedAt`, writes schema 1.1.0,
accepts a date with an empty time as a date-only `localTimeSpec`, bounds both
datetime pickers with `min` set to the record's reference instant, and runs the
temporal validator server-side on submit. The `min` attribute is a convenience;
the server-side check is the authority.

Regression tests, including the real CAL-002 values:

```bash
python3 scripts/gemma-calibration/test_temporal_resolution.py   # 14 tests
```

`pilot-v4-review-hebrew-039` can now be re-annotated. Until it is, it stays
excluded from the freeze.

## Rollback

Additive and inert, like the registry work it builds on. Nothing in the app
imports `lib/calibration/`, no runtime path reads `data/calibration/`, and no
file in the Gemma working copy was modified.

- **Rolling back the freeze**: revert `data/calibration/`. The Gemma pipeline
  keeps working exactly as before — it does not read these files yet.
- **Rolling back the whole issue**: revert the commit. `npm test`'s file list is
  the only shared thing touched.
- **Rolling back a bad adjudication**: do not delete the record. Append a new
  policy version and a superseding adjudication under it. A deleted adjudication
  is indistinguishable from one that was never written, which defeats the
  traceability the whole layer exists for.
- **Rolling back a bad freeze**: supersede it. Never edit it — `FRZ033` will
  catch the edit, and a reverted freeze cannot be told apart from a tampered one.
- **Rolling back a threshold**: change `DEFAULT_GATE_THRESHOLDS` and re-run. Any
  freeze citing the old report keeps citing it; the report records the thresholds
  it was evaluated under, so an old result is never silently re-interpreted under
  new bars.

## Known state

- The gate is **provisional**, on 8 comparable decision items against a
  requirement of 30. This cannot be closed by code — it needs a human doing more
  blind re-review.
- Boundary and commitment-count agreement each rest on a **single** repeat
  annotation. They are measurable now, which they were not; they are not yet
  well-estimated.
- Everything measured is **intra**-reviewer: one person against themselves.
  Whether two reviewers read the guidelines the same way is unmeasured.
- 50 of 5,000 required Gold decisions are reviewed. The pilot-retraining,
  full-training, and release gates in `PILOT_V4_REVIEW_PROGRESS.json` are all
  unmet.
- No training was started, and nothing here authorizes any.
