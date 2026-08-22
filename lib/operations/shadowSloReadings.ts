/**
 * Turning a batch of shadow runs into `ShadowSloReading`s (#46, deliverable 2).
 *
 * **The whole point of this file is the thing it refuses to produce.** Under a
 * definition's `minimumSampleCount` there is no number here — not a zero, not a
 * null with a caveat rendered beside it, but the contract's `inconclusive`
 * variant, which has `value: null` and `breached: null` *in the type*. Nothing
 * downstream can average, plot, or threshold a reading it cannot get a number
 * out of, which is the property that a `sampleCount` field beside an always-present
 * `value` does not have. `evaluateShadowAlert` is the consumer, and it answers
 * `undetermined` rather than `clear`.
 *
 * The second refusal is subtler: a metric whose value comes out non-finite —
 * an empty divisor that survived the sample floor, a corrupted total — becomes
 * `collector_unavailable` rather than a measured `NaN`. `shadowSloBreached`
 * already returns null for a non-finite value so an alert cannot fail open on
 * it, and this is the same decision one layer earlier, where the reading is
 * built.
 *
 * Every measurement is a pure function of the observations handed in.
 * `observedAt` is an input and `windowStart` is derived from it by subtracting
 * the window the definition declares, so a reading always spans exactly the
 * window it claims (`checkShadowSloReading` reports
 * `SLO_READING_WINDOW_INCOHERENT` when it does not) and no clock is read.
 *
 * **What the contract does not carry, stated rather than smuggled:** there is
 * no cost field on any shape in `shadowPipelineContracts`. `ShadowRunObservation`
 * therefore carries `costMicros` as an injected measurement from the caller
 * that ran the pipeline, and `replayAgreed` likewise — a replay is a second run,
 * not a property of the first. Both are `#46`'s additions at the seam, and both
 * are reported to the integration review rather than being made to look like
 * contract fields.
 */

import { instantFromMillis } from '../../src/contracts/v1/safetyContracts';
import {
  SHADOW_MODULE_STATUSES,
  SHADOW_PIPELINE_CHAIN,
  SHADOW_SLO_WINDOW_MILLIS,
  checkShadowTrace,
  millisBetweenInstants,
  shadowSloBreached,
  type Instant,
  type ShadowPipelineOutcome,
  type ShadowPipelineTrace,
  type ShadowSloDefinition,
  type ShadowModuleStatus,
  type ShadowSloMetric,
  type ShadowSloReading,
  type ShadowSloWindow,
} from '../../src/contracts/v1/shadowPipelineContracts';
import {
  SHADOW_SLO_CATALOG,
  type ShadowSloCatalogEntry,
} from './shadowSloCatalog';
import type { ShadowDrillRunResult } from './shadowDrillPipeline';

/* ── What one observed run is ────────────────────────────────────── */

export interface ShadowRunObservation {
  readonly outcome: ShadowPipelineOutcome;
  readonly trace: ShadowPipelineTrace;
  /**
   * What the run cost, in micros. Injected: no contract shape carries a cost,
   * and inventing one here would be this track writing a field into another
   * track's vocabulary.
   */
  readonly costMicros: number;
  /**
   * Whether a replay of this run agreed with the recording, or null when no
   * replay was attempted. Null is not `true`: a run nobody replayed is not a
   * run that reproduced, and counting it as one is how a divergence rate stays
   * flattering.
   */
  readonly replayAgreed: boolean | null;
}

/** A batch, with "the collector did not answer" as a variant rather than an empty array. */
export type ShadowSloBatch =
  | { readonly status: 'collected'; readonly observations: readonly ShadowRunObservation[] }
  | { readonly status: 'collector_unavailable' };

export function shadowRunObservation(
  result: ShadowDrillRunResult,
  replayAgreed: boolean | null,
): ShadowRunObservation {
  return {
    outcome: result.bundle.outcome,
    trace: result.bundle.trace,
    costMicros: result.costMicros,
    replayAgreed,
  };
}

/* ── Windows ─────────────────────────────────────────────────────── */

const EPOCH_INSTANT = '1970-01-01T00:00:00.000Z';

/**
 * The start of the window a reading observed at `observedAt` covers.
 *
 * Arithmetic over an input instant, never `Date.now()`. Throws only for an
 * instant that is not one — a caller that cannot state when it looked has not
 * taken a reading, and returning a plausible-looking window for an unreadable
 * timestamp is the fail-open direction.
 */
export function shadowSloWindowStart(observedAt: Instant, window: ShadowSloWindow): Instant {
  const observedMillis = millisBetweenInstants(EPOCH_INSTANT, observedAt);
  if (observedMillis === null) {
    throw new Error(`a reading states an observation instant that is not one: ${String(observedAt)}`);
  }
  const start = instantFromMillis(observedMillis - SHADOW_SLO_WINDOW_MILLIS[window]);
  if (start === null) throw new Error(`the window start is out of range for ${window}`);
  return start;
}

/* ── Measurement ─────────────────────────────────────────────────── */

/**
 * The p95 of a set of durations, by **nearest rank**: the value at position
 * `ceil(0.95 × n)` of the ascending order, one-indexed.
 *
 * Nearest rank rather than an interpolated percentile because an interpolated
 * p95 reports a number no run took, and an SLO breach an on-call engineer
 * cannot find a run for is a breach they will assume is a bug in the collector.
 * The sort is numeric and total; this file owns no string comparator.
 */
export function shadowLatencyP95(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const ascending = values.slice().sort((left, right) => left - right);
  const rank = Math.ceil(0.95 * ascending.length);
  return ascending[Math.min(rank, ascending.length) - 1];
}

interface Measurement {
  /** The denominator the value was computed over. Reported on the reading. */
  readonly sampleCount: number;
  /**
   * What the definition's floor is compared against — **how much traffic was
   * seen**, which is not always the same as what the rate divides by.
   *
   * They diverge for module-scoped rates, and the divergence matters. A
   * degraded run executes fewer modules: coaching times out, the fail-closed
   * gate downstream is skipped, and six modules run where seven would have.
   * Comparing a floor of "twenty runs' worth of executions" against that count
   * means **the worse the incident, the harder it is to reach the floor** —
   * measured, before this split: twenty runs of a coaching timeout produced a
   * timeout rate of 0.167 against a 0.02 threshold and reported it
   * `inconclusive`, because 120 executions fell short of 140.
   *
   * That is the same backwardness as the denominator defect this file already
   * fixed once, arriving from the other side. Sufficiency is therefore counted
   * in runs for every metric, and the floors are all plain run counts again.
   */
  readonly sufficiencyCount: number;
  readonly value: number;
}

function rate(numerator: number, denominator: number, sufficiencyCount = denominator): Measurement {
  return {
    sampleCount: denominator,
    sufficiencyCount,
    value: denominator === 0 ? Number.NaN : numerator / denominator,
  };
}

/**
 * One metric, over one batch of observations.
 *
 * The sample *unit* differs by metric and is declared in
 * `SHADOW_SLO_SAMPLE_UNIT`: a module-scoped rate counts module executions, and
 * `safety_block_rate` counts only runs that produced a deliverable, because a
 * withheld run has no disposition to read and counting it as "not blocked"
 * would make the gate look calmer the more often it failed to answer.
 */
/**
 * The statuses that mean the module actually ran. Derived by exclusion from
 * `SHADOW_MODULE_STATUSES` rather than listed, so a status added to the
 * contract has to be classified here instead of silently counting as an
 * execution.
 */
const MODULE_NON_EXECUTION_STATUSES: readonly ShadowModuleStatus[] = Object.freeze([
  'skipped',
  'unavailable',
]);

export const MODULE_EXECUTION_STATUSES: readonly ShadowModuleStatus[] = Object.freeze(
  SHADOW_MODULE_STATUSES.filter((status) => !MODULE_NON_EXECUTION_STATUSES.includes(status)),
);

export function measureShadowSloMetric(
  metric: ShadowSloMetric,
  observations: readonly ShadowRunObservation[],
): Measurement {
  const runs = observations.length;

  if (metric === 'pipeline_latency_p95_ms') {
    return {
      sampleCount: runs,
      sufficiencyCount: runs,
      value: shadowLatencyP95(observations.map((item) => item.outcome.totalElapsedMs)),
    };
  }

  if (metric === 'shadow_cost_micros_per_run') {
    let total = 0;
    for (const item of observations) total += item.costMicros;
    return { sampleCount: runs, sufficiencyCount: runs, value: runs === 0 ? Number.NaN : total / runs };
  }

  if (metric === 'module_timeout_rate' || metric === 'module_fallback_rate') {
    const wanted = metric === 'module_timeout_rate' ? 'timed_out' : 'fell_back';
    let matching = 0;
    let executions = 0;
    for (const item of observations) {
      for (const module of SHADOW_PIPELINE_CHAIN) {
        const moduleOutcome = item.outcome.moduleOutcomes[module];
        if (moduleOutcome === undefined || moduleOutcome === null) continue;
        // Executions, not chain slots. `SHADOW_SLO_SAMPLE_UNIT` calls this
        // metric's unit `module_run`, and a module that never ran is not a run.
        //
        // The first version incremented for every member of the chain. Two
        // consequences, both measured:
        //
        //   - `priority` is `skipped` in every real run, so one slot sat in the
        //     denominator that the numerator could never match, and the rate
        //     could not reach 1.0 however completely the pipeline failed;
        //   - worse, the dilution scaled with kill switches. Two modules run,
        //     both time out, six are switched off — a total failure of
        //     everything that executed — read **0.25** against a 0.02 threshold.
        //     The more of the pipeline you disabled, the calmer the timeout rate
        //     became, which is backwards during exactly the incident that causes
        //     switches to be pulled.
        //
        // `skipped` and `unavailable` are the two statuses where no work
        // happened. The remaining three — completed, fell_back, timed_out — are
        // all attempts, and an attempt that fell back is still an attempt that
        // could have timed out.
        if (!MODULE_EXECUTION_STATUSES.includes(moduleOutcome.status)) continue;
        executions += 1;
        if (moduleOutcome.status === wanted) matching += 1;
      }
    }
    // Runs, not executions, for sufficiency — see `Measurement.sufficiencyCount`.
    return rate(matching, executions, runs);
  }

  if (metric === 'pipeline_degraded_rate' || metric === 'pipeline_withheld_rate') {
    const wanted = metric === 'pipeline_degraded_rate' ? 'degraded' : 'withheld';
    const matching = observations.filter((item) => item.outcome.completeness === wanted).length;
    return rate(matching, runs);
  }

  if (metric === 'safety_block_rate') {
    const judged = observations.filter((item) => item.outcome.deliverable !== null);
    const blocked = judged.filter(
      (item) => item.outcome.deliverable !== null && item.outcome.deliverable.safetyDisposition === 'block',
    ).length;
    return rate(blocked, judged.length);
  }

  if (metric === 'replay_divergence_rate') {
    const replayed = observations.filter((item) => item.replayAgreed !== null);
    const diverged = replayed.filter((item) => item.replayAgreed === false).length;
    return rate(diverged, replayed.length);
  }

  // `trace_completeness_rate`, and the compiler holds this branch to being the
  // last one: a metric added to the contract makes this function fall through.
  const complete = observations.filter(
    (item) => checkShadowTrace(item.trace, item.outcome).length === 0,
  ).length;
  return rate(complete, runs);
}

/* ── Readings ────────────────────────────────────────────────────── */

function inconclusiveReading(
  definition: ShadowSloDefinition,
  reason: 'insufficient_sample' | 'no_data_in_window' | 'collector_unavailable',
  sampleCount: number,
  observedAt: Instant,
): ShadowSloReading {
  return Object.freeze({
    status: 'inconclusive' as const,
    sloId: definition.sloId,
    value: null,
    sampleCount,
    breached: null,
    inconclusiveReason: reason,
    windowStart: shadowSloWindowStart(observedAt, definition.window),
    observedAt,
  });
}

/**
 * One reading for one definition.
 *
 * The order of the refusals is the design, and each one is a different fact:
 *
 *   1. the collector did not answer — `collector_unavailable`, and this is
 *      itself an incident;
 *   2. the window is empty — `no_data_in_window`, which is not;
 *   3. the window is thin — `insufficient_sample`, checked against the
 *      definition's own floor, which the contract already refuses to let fall
 *      below `MIN_SLO_SAMPLE_COUNT`;
 *   4. the value is not a finite number — `collector_unavailable` again, on the
 *      grounds that a metric that came out unreadable means the collector is
 *      broken and not that the pipeline is healthy.
 *
 * Only past all four is a `measured` reading produced, and its `breached` is
 * `shadowSloBreached`'s answer rather than a second comparison written here —
 * two spellings of a threshold are two thresholds, and the second one is always
 * the lenient one.
 */
export function computeShadowSloReading(
  definition: ShadowSloDefinition,
  batch: ShadowSloBatch,
  observedAt: Instant,
): ShadowSloReading {
  if (batch.status === 'collector_unavailable') {
    return inconclusiveReading(definition, 'collector_unavailable', 0, observedAt);
  }

  const measurement = measureShadowSloMetric(definition.metric, batch.observations);
  if (measurement.sampleCount === 0 || measurement.sufficiencyCount === 0) {
    return inconclusiveReading(definition, 'no_data_in_window', 0, observedAt);
  }
  // Against `sufficiencyCount`, which is traffic seen, not the rate's
  // denominator. See `Measurement` for why they must not be the same number.
  if (measurement.sufficiencyCount < definition.minimumSampleCount) {
    return inconclusiveReading(definition, 'insufficient_sample', measurement.sampleCount, observedAt);
  }

  const breached = shadowSloBreached(definition, measurement.value);
  if (breached === null) {
    return inconclusiveReading(
      definition,
      'collector_unavailable',
      measurement.sampleCount,
      observedAt,
    );
  }

  return Object.freeze({
    status: 'measured' as const,
    sloId: definition.sloId,
    value: measurement.value,
    sampleCount: measurement.sampleCount,
    breached,
    inconclusiveReason: null,
    windowStart: shadowSloWindowStart(observedAt, definition.window),
    observedAt,
  });
}

export interface ShadowSloReadingRecord {
  readonly entry: ShadowSloCatalogEntry;
  readonly definition: ShadowSloDefinition;
  readonly reading: ShadowSloReading;
}

/** Every catalog entry, read over one batch. Catalog order, never a sort. */
export function computeShadowSloReadings(
  batch: ShadowSloBatch,
  observedAt: Instant,
  catalog: readonly ShadowSloCatalogEntry[] = SHADOW_SLO_CATALOG,
): readonly ShadowSloReadingRecord[] {
  return Object.freeze(
    catalog.map((entry) => ({
      entry,
      definition: entry.definition,
      reading: computeShadowSloReading(entry.definition, batch, observedAt),
    })),
  );
}
