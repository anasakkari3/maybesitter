# Synthetic Gemini evaluation (#330)

The CLI adapters use dedicated synthetic identities (`capture-eval-harness` and
`profile-eval-harness`). Both consent layers receive the same in-memory,
identity-scoped synthetic authorization. No user consent record is created or
changed, and `MAYBESITTER_EVAL_UID` is deliberately ignored. Use these adapters
only with synthetic evaluation corpora, never participant/user content. They
are not imported by production services.

Both commands require `MAYBESITTER_LLM_PROVIDER=gemini`. A configured `none` or
Ollama provider is refused rather than mislabeled as Gemini. Production
profile extraction and the profile evaluation now request the same
`PROFILE_EXTRACTION_SCHEMA`; capture retains its capture schema. Production
consent checks are unchanged.

## Cost and execution gate

These commands make billed Vertex calls. Run them only after the owner approves
spend and supplies credentials through the normal local environment. The
capture CLI's existing batch overrides for daily user/global **call** counts
also apply to the profile batch. They do not lift minute or token caps, bypass
the AI kill switch, skip reservation/usage recording, or guarantee sufficient
quota. Retries/repair can add calls; case count is not a billed-call count.

An interrupted or capped run is a failed evaluation, not evidence that the
model met a quality or safety target. Configure/pause a deliberate batch within
its approved budget; do not silently raise caps to obtain a passing report.
No paid run is established by the unit tests for this adapter.

```sh
npm run capture:eval -- --engine gemini \
  --dataset evaluation-data/capture-messy-multilingual-v1.jsonl \
  --thresholds messy-v1 \
  --report evaluation-reports/capture-messy-gemini.json
npm run profile:eval -- --engine gemini
```

The explicit capture `--report` matters: the CLI otherwise writes its default
`capture-gate-report.json`, not the Gemini path requested by #330. Profile
writes `evaluation-reports/profile-extraction-report.json`.

## What a report establishes

For a requested Gemini capture run, `modelCoveragePassed` requires at least
one Gemini result and refuses unplanned rule fallback, even if the rule result
happens to satisfy the expected answer. The existing pre-model injection and
past-no-action safety refusals remain valid guarded cases. An all-guarded suite
cannot establish model coverage.

Profile evaluation records a failure when a model call, JSON parsing, or the
required suggestions-array shape fails. At least one valid model response is
required. An unavailable model can no longer pass a negative-only suite by
returning nothing. Guarded injection cases still make no model call.

These are evidence-integrity checks, not a substitute for #330's actual billed
run, threshold results, run date and measured cost. Inspect and commit the real
reports only after that authorized run; synthetic stub results are not those
reports.
