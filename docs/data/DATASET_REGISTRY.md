# Dataset registry and evaluation governance

One governed record for every dataset the project trains on, evaluates against,
or reviews by hand — its sources, licences, consent basis, splits, checksums,
lineage, and evaluation status. Plus the rules that make a locked test set
actually immutable, and the report shape that binds an evaluation result to the
exact data, model, and config that produced it.

Sprint 00 · issue [#2](https://github.com/anasakkari3/maybesitter/issues/2).

## Where things live

| Path | What it is |
| --- | --- |
| `lib/evaluation/registry/contracts.ts` | Versioned TypeScript contracts. Single source of truth for every shape below. |
| `lib/evaluation/registry/validateRegistry.ts` | Registry rules (identity, consent, splits, lineage, status). |
| `lib/evaluation/registry/validateLockLedger.ts` | Locked-artifact rules and the registry ↔ ledger cross-check. |
| `lib/evaluation/registry/lockChain.ts` | The append-only chain that makes the ledger tamper-evident. |
| `lib/evaluation/registry/validateEvaluationReport.ts` | Evaluation-report rules and its binding to registered artifacts. |
| `lib/evaluation/registry/verifyArtifacts.ts` | Byte-level verification against a checkout. |
| `data/registry/dataset-registry.json` | The registry itself. |
| `data/registry/locked-artifacts.ledger.json` | Append-only lock ledger. |
| `data/registry/reports/*.report.json` | Governed evaluation reports. |

Contract versions are independent and semver'd: `DATASET_REGISTRY_CONTRACT_VERSION`,
`LOCKED_ARTIFACT_LEDGER_CONTRACT_VERSION`, `EVALUATION_REPORT_CONTRACT_VERSION`.
A file whose contract major version this build does not understand is rejected
rather than partially read.

## Commands

```bash
npm run validate:registry     # registry + ledger + every report
npm run test:registry         # the governance rules themselves
npm run seal:ledger           # recompute chain checksums after appending a row
npm run seal:ledger -- --check
```

The Gemma artifacts are not in this repository — they live in the Gemma pipeline
working copies. Byte-level verification therefore needs an explicit path per
registered repository:

```bash
npm run validate:registry -- \
  --verify maybesitter-gemma=../maybesitter-gemma-gold-calibration \
  --verify maybesitter-gemma-runtime-benchmark=../maybesitter-gemma-runtime-benchmark
```

A repository you do not pass is reported as unverified. It never silently passes.

## The dataset manifest

A registry entry is one dataset. It carries:

- **identity** — `id`, `title`, `version` (semver), `owner` track
- **purpose** — `training`, `evaluation`, `human_review`, `calibration`,
  `benchmark`, or `contract_snapshot`
- **status** — `draft` → `in_review` → `validated_partial` → `validated` →
  `frozen`, or `retired`
- **sources** — each with `url`, `revision`, `license`, `declaredRecordCount`,
  and a `consent` record
- **lineage** — `derivedFrom` (registered dataset ids, or `source:<name>` for
  upstream roots), plus the `producedBy` script, version, and seed
- **artifacts** — the actual files

Each artifact carries `role`, `location` (repository + revision + relative path),
`mediaType`, `recordCount`, `byteSize`, a sha256 `checksum`, a `mutability`, and
`materialized`.

Split roles are `train`, `valid`, and `test`. The other roles — `review_queue`,
`annotation`, `schema_snapshot`, `training_config`, `report`, `benchmark`,
`provenance` — describe supporting files.

### Train / valid / test ownership

Ownership is explicit and exclusive:

- a dataset with `purpose: "training"` must declare exactly one `train`, one
  `valid`, and one `test` artifact (`SPL002`)
- a split role may be claimed by at most one artifact within a dataset (`SPL001`)
- one file may be owned by at most one artifact across the whole registry
  (`ART021`), so no file can be quietly counted as both training and test data

### Consent

Every source needs a reviewed consent record: a `basis`
(`public_license`, `project_owned_synthetic`, `project_owned_authored`,
`user_consented_anonymized`), a `containsPersonalData` flag, a
`personalDataHandling` level, a `redistribution` policy, and who reviewed it when.

Enforced:

- personal data may never be registered `raw` (`SRC020`) and may not be handled
  as `none` (`SRC021`)
- personal data may not be marked freely redistributable (`SRC022`)
- `user_consented_anonymized` requires anonymized or pseudonymized handling
  (`SRC023`)

In the current Gemma corpus this is not theoretical: `gold-decisions.jsonl`,
`per-item-gold.jsonl`, and `calibration/reviewer-metadata.jsonl` all carry a
`reviewerId`, so `gemma3-gold-review` and `gemma3-gold-calibration` are flagged
as containing pseudonymized personal data and are internal-only.

## Locked-test policy

**A locked artifact is immutable. There is no edit path.**

Rules:

1. A `test` artifact may never be `mutable` (`SPL003`). While it is being built
   it may be `append_only`; a warning (`SPL006`) records that it cannot back a
   gate yet.
2. A dataset with status `validated` or `frozen` must have a **locked** test
   artifact (`SPL005`).
3. Every locked artifact needs an active row in the lock ledger (`LCK050`), and
   every active ledger row must point at an artifact registered as locked
   (`LCK042`).
4. The ledger row's checksum must equal the registry's checksum for that
   artifact (`LCK043`) and its record count must match (`LCK044`). **This is the
   check that fails when a locked test set changes.**
5. The bytes on disk must match the registered checksum. For a locked artifact
   this is an error, not a warning (`VER010`).
6. An evaluation report against a `test` artifact requires that artifact to be
   locked (`EVR060`) with an active ledger row whose checksum matches the report
   (`EVR062`).

### Why the ledger is chained

Rule 4 alone is defeatable: edit the artifact, then edit its ledger row to match.
So each ledger row commits to every row before it:

```text
chainChecksum[i] = sha256(canonicalJson({ previous: chainChecksum[i-1], record: row[i] }))
```

Rewriting or deleting any earlier row invalidates every chain checksum after it
(`LCK060`). The only self-consistent way to change a locked artifact is to
*append* a supersession row. The chain head is a single value a reviewer can pin
on the authorizing issue:

```text
current chain head: ea295ba935b38253f6d58a0644222ab6deec334ddc960fac1fe14bc00a76b973
```

This is tamper-*evident*, not tamper-proof. `scripts/seal-lock-ledger.mjs` will
happily reseal a rewritten ledger — what catches that is the chain head on the
issue plus code review of the diff. Any change to
`data/registry/locked-artifacts.ledger.json` that is not a pure append is a
review stop-sign.

### Change procedure for a locked artifact

You cannot edit one. You supersede it.

1. **Open or reference an issue** stating what is wrong with the locked artifact
   and why the evidence it backs is affected. Nothing below happens without it.
2. **Build the replacement under a new artifact id** — `…-v2`, at a new path.
   Never overwrite the original file.
3. **Register the replacement** as a new artifact in `dataset-registry.json`
   with its own checksum and record count.
4. **Retire the original**: set its ledger row `state` to `superseded`, fill in
   `supersededBy` (the new artifact id), `supersessionIssue`, and
   `supersessionReason`, and remove the original artifact from the registry or
   drop it to non-`locked`. A superseded artifact may not remain registered as
   locked (`LCK051`).
5. **Append** a new active ledger row for the replacement, with its own
   `authorizingIssue`.
6. **Reseal**: `npm run seal:ledger`, and record the new chain head on the issue.
7. **Re-run**: `npm run validate:registry` and `npm run test:registry`.
8. **Re-state affected evidence.** Every existing report that referenced the old
   artifact still describes the old bytes. Those reports are not deleted — they
   are historical fact — but they no longer satisfy any gate that requires the
   current locked set. Re-run the evaluations you need.

A supersession that skips any of steps 4–5 fails validation: `LCK021` (no
successor), `LCK022` (successor has no row), `LCK023` (self-supersession),
`LCK024` (no issue), `LCK025` (no reason).

Superseding an artifact by reusing its id is impossible by construction —
`LCK030` rejects two rows for one artifact id.

## Evaluation reports

A governed report is the only artifact that may be cited as evaluation evidence.
It records three fingerprints, all required:

- **data** — `datasetId`, `datasetVersion`, `artifactId`, `checksum`
- **model** — `id`, `runtime`, `checksum` (weight checksum when weights are
  co-located, otherwise the model build/config checksum), `adapter` (an object or
  an explicit `null`), and `promptChecksum` — the prompt is part of the evaluated
  system
- **config** — a `checksum` over the canonical JSON of the run config, plus
  `seed`, `maxTokens`, `decoding`, `repairEnabled`, `limit`

Plus an optional `contractSnapshot` binding the run to the registered output
schema it was scored against, `metrics`, and optional per-slice `slices`.

Enforced:

- an unseeded run is rejected (`EVR032`) — it is not reproducible, so it cannot
  back a gate
- the dataset checksum must match the registry (`EVR053`); a report that
  describes different bytes than the governed artifact is invalid
- the artifact must be registered at all (`EVR050`) at the stated version
  (`EVR052`)
- `contractSnapshot` must resolve to a registered `schema_snapshot` artifact
  (`EVR074`, `EVR075`) at the matching checksum (`EVR076`)
- metric values must be finite numbers or an explicit `null` meaning "not
  measured" (`EVR041`)

Config fingerprints use `canonicalJson` — sorted keys, no incidental whitespace —
so two runs that differ only in key order fingerprint identically, and any real
config change does not.

## Migration notes

### From the per-corpus `DATASET_MANIFEST.json`

`data/DATASET_MANIFEST.json` in the Gemma working copies stays where it is. It is
registered as a `provenance` artifact of `gemma3-extraction-corpus`, and this
registry supersedes it as the governance record. It is not deleted and no
pipeline script needs to change.

The registry does not repeat the manifest's per-intent counts. Those are corpus
statistics, not governance facts.

### From legacy evaluation reports

`scripts/migrate-evaluation-report.mjs` converts an
`expanded-structured-evaluator-v4` report into the governed contract. It reads
the report's `reproducibility` block and resolves the dataset and schema-snapshot
paths to registered artifact ids by matching on path and checksum, so a migrated
report is bound to governed artifacts rather than to loose file paths:

```bash
node --loader ./scripts/ts-resolver.mjs scripts/migrate-evaluation-report.mjs \
  ../maybesitter-gemma-gold-calibration/evaluation-reports/baseline-expanded-v4.json \
  --report-id gemma3-baseline-expanded-v4 \
  --created-at 2026-07-28T00:00:00.000Z \
  --out data/registry/reports/gemma3-baseline-expanded-v4.report.json
```

Two known gaps in migrated reports, both recorded rather than guessed:

- legacy runs did not record decoding parameters, so `decoding` is `{}`
- model weights are not co-located, so `model.checksum` is the model config
  checksum from the legacy `modelConfigSha256`

Per-case output (`*.cases.jsonl`) and the `failures` array stay in the legacy
report. The governed report points at them and does not duplicate them.

### Adding a new dataset

1. Add an entry to `data/registry/dataset-registry.json`.
2. Add its file paths to `CURRENT_GEMMA_DATASET_PATHS` in
   `tests/evaluation/gemmaArtifactCoverage.test.ts`. That list is what makes
   "the registry covers everything" checkable — the test fails both when a known
   artifact is unregistered and when the registry declares something not on the
   list.
3. If any artifact is `locked`, append a ledger row and `npm run seal:ledger`.
4. `npm run validate:registry -- --verify …` and `npm run test:registry`.

## Rollback

Every part of this is additive and inert. Nothing in the app imports
`lib/evaluation/registry/`; no runtime path reads `data/registry/`; no Gemma
pipeline script was modified.

- **Rolling back the registry data**: revert `data/registry/`. The pipeline keeps
  working off the per-corpus manifests exactly as before.
- **Rolling back the whole feature**: revert the commit. The only shared file
  touched is `scripts/ts-resolver.mjs` (see below) and `package.json`'s test list.
- **Rolling back a bad lock**: do not revert the ledger. Supersede, per the
  procedure above — a reverted ledger row is indistinguishable from a tampered
  one, and reviewers cannot tell which happened.
- **Rolling back a contract change**: bump the contract major version and reject
  the old shape explicitly (`REG003`, `LCK003`, `EVR003`) rather than silently
  accepting both.

### One shared file was repaired

`scripts/ts-resolver.mjs` on `main` had only a `resolve` hook and no `load` hook,
so Node could not import any `.ts` file and **every** test in `npm test` failed
with `ERR_UNKNOWN_FILE_EXTENSION`. The `load` hook that transpiles TypeScript was
restored from the working backend copies. `typescript` was already a
devDependency; nothing was added.

This is outside issue #2's scope but was a hard prerequisite: without it no test
in this repository can run at all.

## Known state at time of writing

Recorded because the registry is meant to be honest about what it governs, not
aspirational:

- `gemma3-extraction-corpus` is `validated_partial`. The manifest declares
  115,000 assembled rows; the working copy materializes 3/1/1 sample rows. The
  registry records the sample checksums and says so in each artifact's notes.
- `gemma3-corpus-test` and `gemma3-pilot-v4-test` are `append_only`, not locked
  (`SPL006`). Neither can back a release gate. Evaluation currently runs against
  `gemma3-locked-automated-v4` instead.
- `training-data/pilot-v4-staged/locked_test.jsonl` is empty — no reviewed item
  has been promoted into the staged held-out split.
- Gold review stands at 50 of 5,000 decisions; the 500 / 2,000 / 5,000 gates are
  all unmet.
- Five artifacts were observed in the working tree rather than at the commit they
  are pinned to. Their `location.revision` ends in `+uncommitted`.
- Model weights and adapters are not present in the working copies. They are
  represented as fingerprints inside evaluation reports, not as registry
  artifacts.
