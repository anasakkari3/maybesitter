# Shadow release — operations runbook (Sprint 11, issue #46)

**Scope.** The shadow pipeline runs Capture → … → Safety and shows nobody
anything. Every run in this sprint is at exposure stage `shadow_only`, where the
participant cap is 0 and `wouldHaveBeenShown` is false for every deliverable. If
you are reading this because something is on fire, that is the first fact:
**no user is seeing shadow output**, so nothing here is a user-facing incident.
What can be wrong is that the evidence we are collecting is untrustworthy, or
that the pipeline is spending money and latency for nothing.

Everything below is backed by code and tests, not by this document:

| Concern | Where it lives | Where it is tested |
| --- | --- | --- |
| SLOs, alert queries, ownership | `lib/operations/shadowSloCatalog.ts` | `tests/operations/shadowSloCatalog.test.ts` |
| Readings and the sample floor | `lib/operations/shadowSloReadings.ts` | `tests/operations/shadowSloReadings.test.ts` |
| Privacy-safe logs and reconciliation | `lib/operations/shadowRunLog.ts` | `tests/operations/shadowRunLogReconciliation.test.ts` |
| Kill switches | `lib/operations/shadowKillSwitchDrill.ts` | `tests/operations/shadowKillSwitchDrill.test.ts` |
| The rollback drill | `lib/operations/shadowRollbackDrill.ts` | `tests/operations/shadowRollbackDrill.test.ts` |

---

## 1. The SLOs

Seven definitions covering the five concerns the issue names. Every row passes
the contract's own `checkShadowSloDefinition`, and the test enumerates the five
concerns against this set so a concern that loses its SLO fails the build.

| SLO | concern | metric | comparison | threshold | window | min samples | rotation | escalation | arms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `shadow-pipeline-withheld-rate` | reliability | pipeline_withheld_rate | at_most | 0.05 | rolling_1h | 20 | shadow-oncall-backend | shadow-oncall-backend-lead | safety |
| `shadow-module-timeout-rate` | reliability | module_timeout_rate | at_most | 0.02 | rolling_1h | 160 | shadow-oncall-backend | shadow-oncall-backend-lead | coaching |
| `shadow-replay-divergence-rate` | drift | replay_divergence_rate | at_most | 0.01 | rolling_24h | 20 | shadow-oncall-quality | shadow-oncall-quality-lead | coaching |
| `shadow-safety-block-rate` | safety | safety_block_rate | at_most | 0.1 | rolling_24h | 40 | shadow-oncall-quality | shadow-oncall-quality-lead | coaching |
| `shadow-trace-completeness-rate` | safety | trace_completeness_rate | at_least | 0.99 | rolling_1h | 20 | shadow-oncall-quality | shadow-oncall-quality-lead | — |
| `shadow-pipeline-latency-p95` | latency | pipeline_latency_p95_ms | at_most | 6000 | rolling_1h | 50 | shadow-oncall-backend | shadow-oncall-backend-lead | coaching |
| `shadow-cost-micros-per-run` | cost | shadow_cost_micros_per_run | at_most | 2500 | rolling_24h | 50 | shadow-oncall-product | shadow-oncall-product-lead | — |

**Sample units differ.** `module_timeout_rate` counts *module executions*, so
its floor of 160 is twenty runs of an eight-module chain rather than twenty
stages. `safety_block_rate` counts only runs that produced a deliverable — a
withheld run has no disposition to read, and counting it as "not blocked" would
make the gate look calmer the more often it failed to answer.

**Two metrics in the contract vocabulary deliberately have no SLO**, and the
test requires each to be named with a reason rather than silently unwatched:

- `pipeline_degraded_rate` — `priority` is a placeholder, so no Sprint 11 run
  can be `complete` and this rate is 1.0 by construction.
- `module_fallback_rate` — a fallback is the kill switch working. Paging on it
  would page you for your own mitigation.

**A limit worth knowing before you trust the dashboard.**
`shadow-safety-block-rate` is `at_most`: it sees the gate blocking *too much*.
It cannot see a gate that has silently stopped blocking anything, because in a
healthy corpus the block rate is near zero anyway and an `at_least` SLO on it
would page continuously. That direction is covered by the safety suite
(`tests/safety/*`) and by `shadow-trace-completeness-rate`, not by this SLO.

## 2. Alerts

An alert query is a function, not a string: `shadowAlertQuery(entry)` returns
`(readings) => ShadowAlertVerdict`. There are four states and **no boolean**.

| State | Meaning | Who is paged |
| --- | --- | --- |
| `clear` | The most recent reading is measured and does not breach. | nobody |
| `watch` | Breaching, but fewer consecutive readings than the page threshold. | nobody |
| `paging` | Breaching for at least `pageAfterConsecutiveBreaches` readings. | the primary rotation, then the escalation once `escalateAfterConsecutiveBreaches` is reached |
| `undetermined` | The window could not be read. | only when the reason is `collector_unavailable`, or the readings are malformed or about another SLO |

`undetermined` is **not** `clear`. A reading below the sample floor carries no
value at all — `value: null` and `breached: null` in the type — so there is no
number for a panel to render as 0% and no rollback decision to take on it.

`collector_unavailable` pages and the other two inconclusive reasons do not:
"nothing happened in this window" and "we could not look" are different facts,
and only the second is itself an incident.

## 3. Kill switches

**A kill switch does not turn a module off. It takes the module rules-only**
(`resolveModuleRuntime` → `mode: 'rules_only'`, `allowsModelExecution: false`,
`allowsDirectStateWrites: false`, `captureRemainsAvailable: true`). The
consequence people get wrong under pressure: a rules-only module **still
contributes**, so throwing the safety switch does not withhold runs — it makes
the gate answer with rules instead of not answering at all.

Throw one with an environment variable and restart the runner:

```
MAYBESITTER_KILL_SWITCH_COACHING=true
```

The documented stance per module, asserted one module at a time by
`sweepShadowKillSwitches`:

| Module | stance | status in the trace | reason |
| --- | --- | --- | --- |
| `capture` | rules_only_fallback | fell_back | kill_switch_active |
| `memory` | rules_only_fallback | fell_back | kill_switch_active |
| `priority` | skipped_no_fallback | skipped | kill_switch_active |
| `decomposition` | rules_only_fallback | fell_back | kill_switch_active |
| `planning` | rules_only_fallback | fell_back | kill_switch_active |
| `recommendation` | rules_only_fallback | fell_back | kill_switch_active |
| `coaching` | rules_only_fallback | fell_back | kill_switch_active |
| `safety` | rules_only_fallback | fell_back | kill_switch_active |

`priority` is the exception because it is a placeholder: there is no rules-only
mode for a stub to fall back into, so the honest record is `skipped`. When a
placeholder's switch is thrown the recorded reason is `kill_switch_active` and
not `module_placeholder` — the operator's action is what explains *this* run.

The kill switch outranks the feature flag. If both are set the trace says
`kill_switch_active`, which is what you want to see when you are trying to
work out whether your mitigation took effect.

## 4. Rollback sequence

Run the drill rather than following this list by hand where you can:
`runShadowRollbackDrill` performs steps 1–7 and 10 against fixture state and
generates `rollback-game-day-report.md`.

1. **`confirm_trigger`** — is an SLO actually *paging*, or is the panel showing
   a thin window? An `undetermined` verdict is not a reason to roll back.
2. **`freeze_exposure`** — confirm the stage is `shadow_only`. At this stage
   `resolveShadowExposure` refuses even a participant with granted consent, so
   there is nothing to withdraw; if the stage has moved, that is the first thing
   to put back.
3. **`arm_kill_switches`** — throw the switches the paging SLOs name
   (`definition.killSwitchModule`). If the paging SLO names none — the trace
   completeness and cost SLOs do not — there is no lever, and this is a
   stop-the-drill conversation rather than a config change.
4. **`verify_degraded_run`** — run the pipeline under the armed switches and
   check every armed module reached its documented stance, that no unarmed
   module names a switch, and that the outcome and trace are contract-clean.
5. **`verify_logs_reconcile`** — reconcile the post-rollback logs against their
   traces at `(runId, module)` pair granularity, both directions.
6. **`confirm_slo_recovery`** — re-read the SLOs that tripped, from runs made
   *under the mitigation*. A re-read that comes back inconclusive is not a
   recovery; the drill halts rather than reporting one.
7. **`restore_data_snapshot`** — restore operational data from the pre-drill
   snapshot (`lib/operations/pilotDataBackup.ts`).
8. **`verify_no_canonical_writes`** — not exercisable in this sprint; see §6.
9. **`notify_owners`** — not exercisable in this sprint; see §6.
10. **`stand_down`** — clear the switches and confirm a clean baseline run.

## 5. Migration and rollback notes

- **No schema migration.** #46 adds no persisted format. Everything in
  `lib/operations/shadow*` is computed from bundles a run produced, and nothing
  here writes to `data/`. Rolling this issue back is deleting files.
- **The kill switches are not new.** They are `runtimeControls`' existing
  switches, read through the shipped `readRuntimeControls`. Nothing in this
  issue introduces a second control plane, and rolling #46 back leaves the
  switches exactly as they were.
- **Reverting the SLO catalog** removes alerting, not behaviour: no code path in
  the product reads `SHADOW_SLO_CATALOG` to decide anything. A revert costs
  visibility, never availability.
- **The game-day report is generated.** If the drill changes, regenerate:
  `MAYBESITTER_WRITE_GAME_DAY_REPORT=1 npm run test:sprint11`, and commit the
  regenerated `rollback-game-day-report.md`. A hand-edited report fails its test.
- **Environment.** The only operational inputs are `MAYBESITTER_FEATURE_*` and
  `MAYBESITTER_KILL_SWITCH_*`. Defaults are every feature off except `capture`
  and every switch off, so an environment that sets nothing runs the chain
  rules-only rather than running it unmonitored.

## 6. What this does not cover

Stated here rather than discovered at 3am:

- **Proving the shadow run wrote nothing to canonical state.** The contract
  makes the *outcome* structurally inert and `checkShadowInertness` walks it at
  runtime, both of which the drill exercises. Proving the eight module adapters
  performed no write needs #45's real adapters, which do not exist yet. The
  drill reports this as `not_exercisable / requires_real_orchestrator` rather
  than omitting the step.
- **Delivering a page.** Every owner resolves to a primary and an escalation
  rotation with a channel code, and the drill checks that resolution. Actually
  delivering the page needs a live router:
  `not_exercisable / requires_live_alert_router`.
- **Cost.** No shape in `shadowPipelineContracts` carries a cost, so
  `ShadowRunObservation.costMicros` is supplied by whoever ran the pipeline.
  Until the orchestrator reports it, the cost SLO measures whatever the caller
  passes in.
- **Replay.** `replayAgreed` is likewise an input: a replay is a second run, not
  a property of the first. A run nobody replayed contributes no sample — it is
  never counted as a run that reproduced.

## 7. Commands

```
npm run test:sprint11     # this issue's suites plus the shadow contract suite
npm test                  # the whole repo
npm run typecheck
```
