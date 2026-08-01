# V03 next-step proposal experiment

Tests whether a lightweight contextual or personalized proposal produces a measurable behavioral benefit over the reviewed generic baseline, without becoming more invasive.

## Arms

| Arm | Logic | Inputs |
| --- | --- | --- |
| `generic` | The reviewed V02 deterministic baseline, unchanged | Lateness, urgency, importance, effort |
| `contextual` | Deterministic time-of-day rules layered on the baseline | Local hour, due window, effort size |
| `personalized` | Lightweight per-user counts layered on the contextual rules | The user's own closed commitments |

No arm uses a trained or fine-tuned model, and no arm may propose a commitment the generic baseline ruled ineligible — arms only reorder candidates the baseline already found confirmed, open, and evidenced. Every arm keeps the one-step product contract: `sensitiveInferenceUsed: false`, no persistence, confirmation still required.

`personalized` reads only the current user's own completed and dropped commitments, held locally, and needs at least three of them (`MINIMUM_PROFILE_OBSERVATIONS`). Below that it falls back to the contextual rules and records `fallbackReason`. The profile stores counts by commitment kind and completion hour — never titles, people, or message content.

## Assignment

Arm assignment is `assignExperiment(anonymousUserId, 'v03-next-step-proposal', NEXT_STEP_ARMS)` — the same deterministic hash that stamps the analytics envelope. There is no second source of truth, so the arm recorded on an event is always the arm that produced the proposal.

The experiment is **off unless explicitly enabled**:

```
MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS=true
```

Unset or `false` serves the reviewed generic baseline to every user and stamps no V03 experiment id. This is independent of the V02 recommendation feature flag and kill switch, which still gate the feature itself.

## Measures

Recorded per proposal, keyed on `anonymousUserId + proposalId`:

- **Behavioral** — acceptance, completion, dismissal, correction (edit), and deferral rates over exposures.
- **Self-reported** — `recommendation_rated` carries `utilityRating` and `invasivenessRating`, both integers 1-5; invasiveness is worse when higher. Values outside the scale are rejected by the schema validator.
- **Latency and cost** — `recommendation_shown` carries `latencyMs` and `costMicros`. All three arms are deterministic and local, so cost is 0 by construction; the field exists so a future arm that spends money cannot be compared without it.
- **Assignment integrity** — events from another experiment or an unknown arm are excluded and counted, users appearing in more than one arm are listed as contamination, and arm share is checked against an even split.

## Decision rule

Encoded in `EXPERIMENT_DECISION_POLICY` and enforced by `buildExperimentReport`. An arm is approved only when **all** hold:

1. A behavioral metric (`acceptanceRate` or `completionRate`) beats baseline by at least 0.05 with a 95% confidence interval excluding zero.
2. Invasiveness has not risen more than 0.25 scale points.
3. The correction rate has not risen more than 0.1.
4. Per-arm exposures and decisions meet the minimums, with no cross-arm contamination.

Utility and invasiveness ratings are listed in `selfReportedMetrics` and are never sufficient on their own. `tests/experiments/experimentReport.test.ts` pins this: an arm rated a full 3 points higher than baseline with identical acceptance is still rejected, with `no_behavioral_metric_cleared_the_effect_bar` as its blocker.

Effect sizes are reported for every metric regardless of approval — rate difference, relative lift, 95% Wald interval, and Cohen's h for proportions; mean difference, Welch interval, and Cohen's d for ratings. Sample limitations are reported separately from blockers so an underpowered result reads as "not yet measurable" rather than "no effect".

## Running it

```
npm run test:v03-experiment
npm run experiment:report -- --events <jsonl> --report <json> --at <iso>
```

The report defaults to `evaluation-data/v03-experiment-events.jsonl` and `evaluation-reports/v03-experiment-report.json`. The committed fixture is synthetic and exists to exercise the analysis: its contextual arm has a genuine acceptance effect and passes, and its personalized arm is rated highest while showing no behavioral effect and a worse invasiveness score, so it fails. **No pilot data has been collected and no arm has been approved.**

## Rollback

Set `MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS=false` (or unset it). Every user returns to the reviewed generic baseline on the next request; no data migration is needed and previously recorded events stay valid under the same schema version. The `recommendation_rated` event and the `latencyMs`/`costMicros` properties are additive v1 extensions — older events without them remain valid, and the report treats a missing measure as absent rather than zero.
