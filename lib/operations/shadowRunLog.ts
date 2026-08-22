/**
 * Privacy-safe shadow run logs, and their reconciliation with traces (#46).
 *
 * The acceptance criterion is two claims at once, and the design is what stops
 * either from being satisfied by the other's slack.
 *
 * ── Privacy ─────────────────────────────────────────────────────────
 *
 * A line carries `SHADOW_LOG_RECONCILIATION_FIELDS` and one closed-vocabulary
 * `kind`. Every one of those is a position, a closed vocabulary, a
 * pattern-checked identifier, a digest or an instant: there is no field on a
 * line that can hold a sentence. That is a property of the emitter, and an
 * emitter is not a check — so `shadowLogPrivacyErrors` puts *whatever line it is
 * handed* through the **shipped** `validateAnalyticsEvent`, property by
 * property, and reports the three verdicts that mean content:
 * `private property is forbidden`, `property must be scalar`, and
 * `property is too long`. A key-name scan alone would ship the transcript in
 * `properties.note`; the value-shaped verdicts are what close that.
 *
 * **The seam, stated because it is a compromise.** A shadow log line is not an
 * `AnalyticsEventName` and cannot become one without editing
 * `src/contracts/v1/analyticsEventContracts.ts` and
 * `lib/analytics/privacySafeEvents.ts`, neither of which is #46's to edit. So
 * the line is not submitted as an analytics event; each of its properties is
 * submitted inside a minimal probe envelope, and only the three privacy
 * verdicts are read back. The `property is not allowed for …` verdict is
 * deliberately ignored: that one is the analytics *allowlist*, which is about
 * which fields belong on which product event, and it has no opinion about a
 * pipeline log line. What is borrowed is the judgement this repo already ships
 * about which property names and shapes may hold personal content — borrowed
 * rather than copied, so `SHADOW_FORBIDDEN_LOG_KEY_CLASSES` and the validator
 * cannot drift into two answers.
 *
 * ── Reconciliation ──────────────────────────────────────────────────
 *
 * At `(runId, module)` **pair** granularity, **with multiplicity**, in both
 * directions. Never a deduplicated set of identifiers: Sprint 08 reported
 * perfect agreement between two readers that disagreed on 38% of inputs
 * because a set comparison cannot see a line duplicated in one run and missing
 * in another — the two cancel, and the totals still match. `countMismatches`
 * is that shape made visible, and `tests/operations/shadowRunLogReconciliation.test.ts`
 * constructs it deliberately and asserts the set-based answer would have been
 * "perfect".
 *
 * Every line also goes through the contract's own
 * `checkShadowLogReconciliation`, which is the authority on run-id agreement,
 * digest agreement, and the half-located line — a line naming a module but no
 * position, which is the shape that would otherwise be counted as reconciled
 * because there was nothing to compare it against.
 */

import {
  ANALYTICS_EVENT_CONTRACT_VERSION,
} from '../../src/contracts/v1/analyticsEventContracts';
import { validateAnalyticsEvent } from '../analytics/privacySafeEvents';
import {
  SHADOW_LOG_RECONCILIATION_FIELDS,
  SHADOW_PIPELINE_CHAIN,
  checkShadowLogReconciliation,
  type Instant,
  type ShadowLogReconciliationKey,
  type ShadowPipelineDefect,
  type ShadowPipelineModule,
  type ShadowPipelineTrace,
} from '../../src/contracts/v1/shadowPipelineContracts';

/* ── Lines ───────────────────────────────────────────────────────── */

/**
 * Why a line was written. Closed, because a run-level line and a stage-level
 * line are otherwise distinguishable only by their instants, and "the run
 * started" and "the run finished" are the two lines an operator looks for first.
 */
export type ShadowLogKind = 'run_started' | 'stage_recorded' | 'run_finished';

export const SHADOW_LOG_KINDS = Object.freeze([
  'run_started',
  'stage_recorded',
  'run_finished',
] as const) satisfies readonly ShadowLogKind[];

/**
 * A written line.
 *
 * A **type alias rather than an interface**, and the reason is mechanical: an
 * interface has no implicit index signature, so an interface-typed line is not
 * assignable to the `Readonly<Record<string, unknown>>` that
 * `checkShadowLogReconciliation` and the privacy gate take — and both of those
 * take an open record on purpose, because a forbidden-key scan has to see every
 * property and not the ones somebody remembered to declare. The alias is the
 * shape that can be handed to a checker that doubts it.
 *
 * The field list is pinned against `SHADOW_LOG_RECONCILIATION_FIELDS` below, so
 * a sixth reconciliation field added to the contract fails to compile here
 * rather than being quietly unwritten.
 */
export type ShadowRunLogLine = {
  readonly kind: ShadowLogKind;
  readonly runId: string;
  readonly module: ShadowPipelineModule | null;
  readonly stagePosition: number | null;
  readonly bundleDigest: string;
  readonly occurredAt: Instant;
};

type _LineCoversKey =
  Exclude<keyof ShadowLogReconciliationKey, keyof ShadowRunLogLine> extends never ? true : never;
const _lineCoversKey: _LineCoversKey = true;
export const SHADOW_LOG_LINE_COVERS_KEY = _lineCoversKey;

/**
 * One line per stage, plus the two the run itself gets.
 *
 * Instants are taken from the trace and never from a clock: a stage line is
 * stamped at the moment the stage ended, which is the moment the record could
 * first have been written, and the finish line is stamped at `recordedAt`.
 */
export function emitShadowRunLog(
  trace: ShadowPipelineTrace,
  bundleDigest: string,
): readonly ShadowRunLogLine[] {
  const first = trace.stages.length > 0 ? trace.stages[0].startedAt : trace.recordedAt;
  const lines: ShadowRunLogLine[] = [
    {
      kind: 'run_started',
      runId: trace.runId,
      module: null,
      stagePosition: null,
      bundleDigest,
      occurredAt: first,
    },
  ];

  for (const stage of trace.stages) {
    lines.push({
      kind: 'stage_recorded',
      runId: trace.runId,
      module: stage.module,
      stagePosition: stage.position,
      bundleDigest,
      occurredAt: stage.endedAt,
    });
  }

  lines.push({
    kind: 'run_finished',
    runId: trace.runId,
    module: null,
    stagePosition: null,
    bundleDigest,
    occurredAt: trace.recordedAt,
  });

  return Object.freeze(lines);
}

/* ── Privacy, judged by the shipped validator ────────────────────── */

/**
 * The envelope exists only to get `validateAnalyticsEvent` as far as its
 * property loop; every field of it is a constant, and none of it is read back.
 * The instant is a literal rather than a clock read, on this track's no-ambient-
 * clock rule.
 */
const PROBE_ENVELOPE = Object.freeze({
  version: ANALYTICS_EVENT_CONTRACT_VERSION,
  eventId: 'shadow-log-privacy-probe',
  eventName: 'capture_submitted',
  occurredAt: '2027-01-01T00:00:00.000Z',
  anonymousUserId: 'shadow-log-privacy-probe',
  cohortId: 'shadow-log-privacy-probe',
  experiment: null,
  consent: 'granted',
});

/**
 * The verdicts that mean "this property could hold personal content".
 *
 * `property is not allowed for …` is deliberately absent — see the header.
 */
const PRIVACY_VERDICTS = Object.freeze([
  'private property is forbidden',
  'property must be scalar',
  'property is too long',
]);

export interface ShadowLogPrivacyViolation {
  readonly lineIndex: number;
  readonly key: string;
  readonly error: string;
}

/**
 * The keys a privacy-safe line may carry: the reconciliation vocabulary the
 * contract names, plus the line's own `kind`.
 *
 * Derived from `SHADOW_LOG_RECONCILIATION_FIELDS` rather than listed, so a field
 * added to the contract arrives here without an edit and a field removed from it
 * stops being permitted.
 */
const PERMITTED_LOG_KEYS: readonly string[] = Object.freeze([
  ...SHADOW_LOG_RECONCILIATION_FIELDS,
  'kind',
]);

/**
 * The privacy judgement about one line, property by property.
 * Empty means the line carries nothing that could hold content.
 *
 * ── Why a closed vocabulary, and not only the validator ──────────
 *
 * This module's header argues that "a key-name scan alone would ship the
 * transcript in `properties.note`; the value-shaped verdicts are what close
 * that". They did not. The shipped validator's value-shaped verdicts are
 * *longer than 128 characters* and *not scalar* — so a 56-character sentence
 * under an innocuous key passed the gate, and an integration review demonstrated
 * exactly the case the header names:
 *
 *     properties.note = "relapsed tuesday, has not told wife, clinic on Elm St 4pm"
 *     -> shadowLogPrivacyErrors: []      reconciled: true      violations: 0
 *
 * The reason the validator could not catch it is that this module deliberately
 * ignores its `property is not allowed for …` verdict — the one verdict that
 * enforces a closed vocabulary — because the shadow line is not a registered
 * analytics event and every key would be refused.
 *
 * So the closure is enforced here, against the contract's own field list. A
 * `ShadowRunLogLine` has five fields and a kind; anything else on a line handed
 * to this function is refused whatever it contains. The validator still runs,
 * and still contributes the three value- and name-shaped verdicts, because a
 * permitted key can also carry an impermissible value — `occurredAt` holding a
 * paragraph is a real thing to catch.
 *
 * This is a check, not a restatement of the emitter: the emitter never produces
 * a stray key, and the whole point is that `shadowLogPrivacyErrors` judges
 * whatever line it is handed.
 */
export function shadowLogPrivacyErrors(line: Readonly<Record<string, unknown>>): readonly string[] {
  const errors: string[] = [];
  for (const key of Object.keys(line)) {
    // Both checks run on every key. Not `continue`: the validator's verdicts
    // are what make this a judgement by the shipped rules rather than a copy
    // of them, and short-circuiting past it would hide the evidence for that.
    // A stray key named `email` is reported as a forbidden name *and* as
    // outside the vocabulary, because those are two different reasons.
    if (!PERMITTED_LOG_KEYS.includes(key)) {
      errors.push(`key is not part of the shadow log vocabulary: ${key}`);
    }
    const result = validateAnalyticsEvent({ ...PROBE_ENVELOPE, properties: { [key]: line[key] } });
    for (const error of result.errors) {
      for (const verdict of PRIVACY_VERDICTS) {
        if (error.indexOf(`${verdict}: ${key}`) === 0) errors.push(error);
      }
    }
  }
  return Object.freeze(errors);
}

/* ── Reconciliation ──────────────────────────────────────────────── */

export interface ShadowLoggedRun {
  readonly trace: ShadowPipelineTrace;
  readonly bundleDigest: string;
}

export interface ShadowLogPairCount {
  readonly runId: string;
  readonly module: ShadowPipelineModule;
  readonly stagePosition: number;
  readonly traceCount: number;
  readonly logCount: number;
}

export interface ShadowLogReconciliationReport {
  readonly reconciled: boolean;
  readonly runIds: readonly string[];
  /** Stage pairs the traces carry, with multiplicity. */
  readonly tracePairs: number;
  /** Stage pairs the log lines carry, with multiplicity. */
  readonly logPairs: number;
  readonly matchedPairs: number;
  readonly stagesWithoutLine: readonly ShadowLogPairCount[];
  readonly linesWithoutStage: readonly ShadowLogPairCount[];
  /** Pairs both sides have, in different numbers. The set comparison blind spot. */
  readonly countMismatches: readonly ShadowLogPairCount[];
  readonly unattributedLines: readonly { readonly lineIndex: number; readonly runId: string }[];
  readonly privacyViolations: readonly ShadowLogPrivacyViolation[];
  readonly defects: readonly ShadowPipelineDefect[];
  readonly runLevelLines: number;
}

interface RunBucket {
  readonly run: ShadowLoggedRun;
  readonly traceCounts: Record<string, number>;
  readonly logCounts: Record<string, number>;
}

function emptyCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const module of SHADOW_PIPELINE_CHAIN) counts[module] = 0;
  return counts;
}

/**
 * Reconcile a batch of runs against a batch of lines.
 *
 * A batch rather than a single run, because the failure this is built against
 * is a *cross-run* one: the duplicate and the absence that cancel are in
 * different runs, and a per-run reconciler run in a loop would report each run
 * as internally consistent if it compared only totals.
 */
export function reconcileShadowRunLogs(
  runs: readonly ShadowLoggedRun[],
  lines: readonly Readonly<Record<string, unknown>>[],
): ShadowLogReconciliationReport {
  const buckets: RunBucket[] = runs.map((run) => ({
    run,
    traceCounts: emptyCounts(),
    logCounts: emptyCounts(),
  }));

  for (const bucket of buckets) {
    for (const stage of bucket.run.trace.stages) {
      if (bucket.traceCounts[stage.module] === undefined) bucket.traceCounts[stage.module] = 0;
      bucket.traceCounts[stage.module] += 1;
    }
  }

  const defects: ShadowPipelineDefect[] = [];
  const privacyViolations: ShadowLogPrivacyViolation[] = [];
  const unattributedLines: { lineIndex: number; runId: string }[] = [];
  let runLevelLines = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    for (const error of shadowLogPrivacyErrors(line)) {
      const key = error.slice(error.lastIndexOf(': ') + 2);
      privacyViolations.push({ lineIndex: index, key, error });
    }

    const runId = line.runId;
    let bucket: RunBucket | null = null;
    for (const candidate of buckets) {
      if (candidate.run.trace.runId === runId) bucket = candidate;
    }
    if (bucket === null) {
      unattributedLines.push({ lineIndex: index, runId: typeof runId === 'string' ? runId : '' });
      continue;
    }

    for (const defect of checkShadowLogReconciliation(line, bucket.run.trace, bucket.run.bundleDigest)) {
      defects.push(defect);
    }

    const module = line.module;
    if (module === null || module === undefined) {
      runLevelLines += 1;
      continue;
    }
    const moduleKey = String(module);
    if (bucket.logCounts[moduleKey] === undefined) bucket.logCounts[moduleKey] = 0;
    bucket.logCounts[moduleKey] += 1;
  }

  const stagesWithoutLine: ShadowLogPairCount[] = [];
  const linesWithoutStage: ShadowLogPairCount[] = [];
  const countMismatches: ShadowLogPairCount[] = [];
  let tracePairs = 0;
  let logPairs = 0;
  let matchedPairs = 0;

  for (const bucket of buckets) {
    const modules: string[] = [];
    for (const key of Object.keys(bucket.traceCounts)) modules.push(key);
    for (const key of Object.keys(bucket.logCounts)) {
      if (modules.indexOf(key) === -1) modules.push(key);
    }

    for (const moduleKey of modules) {
      const traceCount = bucket.traceCounts[moduleKey] ?? 0;
      const logCount = bucket.logCounts[moduleKey] ?? 0;
      tracePairs += traceCount;
      logPairs += logCount;
      matchedPairs += Math.min(traceCount, logCount);
      if (traceCount === logCount) continue;

      const module = moduleKey as ShadowPipelineModule;
      const pair: ShadowLogPairCount = {
        runId: bucket.run.trace.runId,
        module,
        stagePosition: SHADOW_PIPELINE_CHAIN.indexOf(module),
        traceCount,
        logCount,
      };
      if (logCount === 0) stagesWithoutLine.push(pair);
      else if (traceCount === 0) linesWithoutStage.push(pair);
      else countMismatches.push(pair);
    }
  }

  const reconciled =
    stagesWithoutLine.length === 0 &&
    linesWithoutStage.length === 0 &&
    countMismatches.length === 0 &&
    unattributedLines.length === 0 &&
    privacyViolations.length === 0 &&
    defects.length === 0;

  return Object.freeze({
    reconciled,
    runIds: Object.freeze(runs.map((run) => run.trace.runId)),
    tracePairs,
    logPairs,
    matchedPairs,
    stagesWithoutLine: Object.freeze(stagesWithoutLine),
    linesWithoutStage: Object.freeze(linesWithoutStage),
    countMismatches: Object.freeze(countMismatches),
    unattributedLines: Object.freeze(unattributedLines),
    privacyViolations: Object.freeze(privacyViolations),
    defects: Object.freeze(defects),
    runLevelLines,
  });
}

/** Emit and reconcile in one step, for a caller that has just run the pipeline. */
export function emitAndReconcileShadowRunLogs(
  runs: readonly ShadowLoggedRun[],
): { readonly lines: readonly ShadowRunLogLine[]; readonly report: ShadowLogReconciliationReport } {
  const lines: ShadowRunLogLine[] = [];
  for (const run of runs) {
    for (const line of emitShadowRunLog(run.trace, run.bundleDigest)) lines.push(line);
  }
  return { lines: Object.freeze(lines), report: reconcileShadowRunLogs(runs, lines) };
}

/** The instant a line was stamped with, for a caller ordering an operator view. */
export function shadowLogLineInstant(line: ShadowRunLogLine): Instant {
  return line.occurredAt;
}
