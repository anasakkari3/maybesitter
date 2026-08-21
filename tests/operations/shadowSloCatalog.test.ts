/**
 * #46, deliverable 1 and acceptance criterion "alert ownership is explicit".
 *
 * What this file is trying not to be: a test that reads the catalog and asserts
 * the catalog says what it says. Three things are held against something other
 * than the catalog itself —
 *
 *   1. the **contract's** checker (`checkShadowSloDefinition`) passes every
 *      definition, so the owner, the sample floor and the kill-switch module are
 *      judged by the file that defines what those mean;
 *   2. the **five concerns the issue names** are enumerated from a literal list
 *      here, so a concern that loses its SLO fails rather than being noticed by
 *      nobody, and a concern invented later has to be added in two places;
 *   3. every threshold and comparator is **mutated one at a time** and the probe
 *      that breached must stop breaching, so a threshold nobody reads is a
 *      failing test rather than a comment.
 *
 * The literal tables below are deliberately literals. Sprint 10's review found
 * every floor mutable in both directions because the fixtures were built from
 * the constant they were testing; a table written as `definition.threshold`
 * would reproduce that exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_SLO_SAMPLE_COUNT,
  SHADOW_PIPELINE_CHAIN,
  SHADOW_PIPELINE_TOTAL_BUDGET_MS,
  SHADOW_SLO_METRICS,
  SHADOW_SLO_WINDOW_MILLIS,
  checkShadowSloDefinition,
  checkShadowSloReading,
  shadowSloBreached,
  type Instant,
  type ShadowSloDefinition,
  type ShadowSloInconclusiveReason,
  type ShadowSloMetric,
  type ShadowSloReading,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { INTELLIGENCE_MODULES } from '../../src/contracts/v1/moduleContracts.ts';
import {
  SHADOW_ONCALL_ROTATIONS,
  SHADOW_SLO_CATALOG,
  SHADOW_SLO_CONCERNS,
  SHADOW_SLO_DEFINITIONS,
  SHADOW_SLO_METRIC_EXEMPTIONS,
  SHADOW_SLO_SAMPLE_UNIT,
  evaluateShadowAlert,
  resolveShadowRotation,
  resolveShadowSloOwner,
  shadowAlertQuery,
  shadowSloById,
  shadowSlosForConcern,
  type ShadowSloCatalogEntry,
  type ShadowSloConcern,
} from '../../lib/operations/shadowSloCatalog.ts';
import { shadowSloWindowStart } from '../../lib/operations/shadowSloReadings.ts';

const OBSERVED_AT: Instant = '2027-01-14T12:00:00.000Z';

/** The five the issue names, written out rather than imported from the thing under test. */
const CONCERNS_THE_ISSUE_NAMES: readonly ShadowSloConcern[] = [
  'reliability',
  'drift',
  'safety',
  'latency',
  'cost',
];

/**
 * Every shipped SLO, as literals. The last column is the smallest step that
 * moves a value across the threshold — used by the mutation sweep, and per
 * metric because a rate and a millisecond count do not have the same grain.
 */
const EXPECTED: readonly {
  readonly sloId: string;
  readonly concern: ShadowSloConcern;
  readonly metric: ShadowSloMetric;
  readonly comparison: 'at_most' | 'at_least';
  readonly threshold: number;
  readonly window: 'rolling_1h' | 'rolling_24h' | 'rolling_7d';
  readonly minimumSampleCount: number;
  readonly rotationId: string;
  readonly escalationRotationId: string;
  readonly killSwitchModule: string | null;
  readonly step: number;
}[] = [
  {
    sloId: 'shadow-pipeline-withheld-rate',
    concern: 'reliability',
    metric: 'pipeline_withheld_rate',
    comparison: 'at_most',
    threshold: 0.05,
    window: 'rolling_1h',
    minimumSampleCount: 20,
    rotationId: 'shadow-oncall-backend',
    escalationRotationId: 'shadow-oncall-backend-lead',
    killSwitchModule: 'safety',
    step: 0.001,
  },
  {
    sloId: 'shadow-module-timeout-rate',
    concern: 'reliability',
    metric: 'module_timeout_rate',
    comparison: 'at_most',
    threshold: 0.02,
    window: 'rolling_1h',
    minimumSampleCount: 160,
    rotationId: 'shadow-oncall-backend',
    escalationRotationId: 'shadow-oncall-backend-lead',
    killSwitchModule: 'coaching',
    step: 0.001,
  },
  {
    sloId: 'shadow-replay-divergence-rate',
    concern: 'drift',
    metric: 'replay_divergence_rate',
    comparison: 'at_most',
    threshold: 0.01,
    window: 'rolling_24h',
    minimumSampleCount: 20,
    rotationId: 'shadow-oncall-quality',
    escalationRotationId: 'shadow-oncall-quality-lead',
    killSwitchModule: 'coaching',
    step: 0.001,
  },
  {
    sloId: 'shadow-safety-block-rate',
    concern: 'safety',
    metric: 'safety_block_rate',
    comparison: 'at_most',
    threshold: 0.1,
    window: 'rolling_24h',
    minimumSampleCount: 40,
    rotationId: 'shadow-oncall-quality',
    escalationRotationId: 'shadow-oncall-quality-lead',
    killSwitchModule: 'coaching',
    step: 0.001,
  },
  {
    sloId: 'shadow-trace-completeness-rate',
    concern: 'safety',
    metric: 'trace_completeness_rate',
    comparison: 'at_least',
    threshold: 0.99,
    window: 'rolling_1h',
    minimumSampleCount: 20,
    rotationId: 'shadow-oncall-quality',
    escalationRotationId: 'shadow-oncall-quality-lead',
    killSwitchModule: null,
    step: 0.001,
  },
  {
    sloId: 'shadow-pipeline-latency-p95',
    concern: 'latency',
    metric: 'pipeline_latency_p95_ms',
    comparison: 'at_most',
    threshold: 6000,
    window: 'rolling_1h',
    minimumSampleCount: 50,
    rotationId: 'shadow-oncall-backend',
    escalationRotationId: 'shadow-oncall-backend-lead',
    killSwitchModule: 'coaching',
    step: 1,
  },
  {
    sloId: 'shadow-cost-micros-per-run',
    concern: 'cost',
    metric: 'shadow_cost_micros_per_run',
    comparison: 'at_most',
    threshold: 2500,
    window: 'rolling_24h',
    minimumSampleCount: 50,
    rotationId: 'shadow-oncall-product',
    escalationRotationId: 'shadow-oncall-product-lead',
    killSwitchModule: null,
    step: 1,
  },
];

function entryFor(sloId: string): ShadowSloCatalogEntry {
  const entry = shadowSloById(sloId);
  assert.ok(entry, `the catalog no longer contains ${sloId} — the expectation table is stale`);
  return entry;
}

/** A value on the breaching side of the threshold, by exactly one step. */
function justBreaching(definition: ShadowSloDefinition, step: number): number {
  return definition.comparison === 'at_most'
    ? definition.threshold + step
    : definition.threshold - step;
}

function measured(
  definition: ShadowSloDefinition,
  value: number,
  sampleCount: number,
  observedAt: Instant = OBSERVED_AT,
): ShadowSloReading {
  const breached = shadowSloBreached(definition, value);
  assert.notEqual(breached, null, 'the probe value is not comparable against this definition');
  return {
    status: 'measured',
    sloId: definition.sloId,
    value,
    sampleCount,
    breached: breached as boolean,
    inconclusiveReason: null,
    windowStart: shadowSloWindowStart(observedAt, definition.window),
    observedAt,
  };
}

function inconclusive(
  definition: ShadowSloDefinition,
  reason: ShadowSloInconclusiveReason,
  sampleCount = 0,
): ShadowSloReading {
  return {
    status: 'inconclusive',
    sloId: definition.sloId,
    value: null,
    sampleCount,
    breached: null,
    inconclusiveReason: reason,
    windowStart: shadowSloWindowStart(OBSERVED_AT, definition.window),
    observedAt: OBSERVED_AT,
  };
}

/* ── The set itself ──────────────────────────────────────────────── */

test('every shipped definition passes the contract own checker', () => {
  for (const entry of SHADOW_SLO_CATALOG) {
    assert.deepEqual(
      checkShadowSloDefinition(entry.definition),
      [],
      `${entry.definition.sloId} is not a well-formed definition`,
    );
  }
  assert.equal(SHADOW_SLO_DEFINITIONS.length, SHADOW_SLO_CATALOG.length);
});

test('each of the five concerns the issue names has at least one SLO', () => {
  assert.deepEqual([...SHADOW_SLO_CONCERNS], [...CONCERNS_THE_ISSUE_NAMES]);
  for (const concern of CONCERNS_THE_ISSUE_NAMES) {
    const entries = shadowSlosForConcern(concern);
    assert.ok(
      entries.length >= 1,
      `the concern "${concern}" has no SLO; the issue names it as a thing that must be visible`,
    );
    for (const entry of entries) assert.equal(entry.concern, concern);
  }
});

test('no SLO belongs to a concern outside the five', () => {
  for (const entry of SHADOW_SLO_CATALOG) {
    assert.ok(
      CONCERNS_THE_ISSUE_NAMES.indexOf(entry.concern) !== -1,
      `${entry.definition.sloId} claims the concern "${entry.concern}"`,
    );
  }
});

test('thresholds, windows and sample floors are pinned as literals', () => {
  assert.equal(SHADOW_SLO_CATALOG.length, EXPECTED.length, 'an SLO arrived or left unpinned');
  for (const expected of EXPECTED) {
    const definition = entryFor(expected.sloId).definition;
    assert.equal(entryFor(expected.sloId).concern, expected.concern, expected.sloId);
    assert.equal(definition.metric, expected.metric, expected.sloId);
    assert.equal(definition.comparison, expected.comparison, expected.sloId);
    assert.equal(definition.threshold, expected.threshold, expected.sloId);
    assert.equal(definition.window, expected.window, expected.sloId);
    assert.equal(definition.minimumSampleCount, expected.minimumSampleCount, expected.sloId);
    assert.equal(definition.owner.rotationId, expected.rotationId, expected.sloId);
    assert.equal(definition.owner.escalationRotationId, expected.escalationRotationId, expected.sloId);
    assert.equal(definition.killSwitchModule, expected.killSwitchModule, expected.sloId);
  }
});

test('the contract sample floor is 20 and no definition sits below it', () => {
  assert.equal(MIN_SLO_SAMPLE_COUNT, 20);
  for (const entry of SHADOW_SLO_CATALOG) {
    assert.ok(
      entry.definition.minimumSampleCount >= 20,
      `${entry.definition.sloId} accepts fewer than twenty samples`,
    );
  }
});

test('a module-run metric carries a sample floor scaled by the chain length', () => {
  assert.equal(SHADOW_PIPELINE_CHAIN.length, 8);
  for (const entry of SHADOW_SLO_CATALOG) {
    if (SHADOW_SLO_SAMPLE_UNIT[entry.definition.metric] !== 'module_run') continue;
    assert.ok(
      entry.definition.minimumSampleCount >= 20 * 8,
      `${entry.definition.sloId} counts module executions, so twenty samples is two and a half runs`,
    );
  }
});

test('a definition below the floor is rejected on both sides of it', () => {
  const definition = entryFor('shadow-pipeline-withheld-rate').definition;
  assert.deepEqual(checkShadowSloDefinition({ ...definition, minimumSampleCount: 20 }), []);
  assert.deepEqual(
    checkShadowSloDefinition({ ...definition, minimumSampleCount: 19 }).map((defect) => defect.code),
    ['SLO_SAMPLE_FLOOR_TOO_LOW'],
  );
});

test('the latency threshold sits below the ceiling the pipeline already fails at', () => {
  const definition = entryFor('shadow-pipeline-latency-p95').definition;
  assert.equal(SHADOW_PIPELINE_TOTAL_BUDGET_MS, 8000);
  assert.ok(
    definition.threshold < SHADOW_PIPELINE_TOTAL_BUDGET_MS,
    'a latency SLO at or above the total budget can only fire after every run is already timing out',
  );
});

test('sloIds are unique and no two SLOs watch the same metric in the same window', () => {
  const ids: string[] = [];
  const pairs: string[] = [];
  for (const entry of SHADOW_SLO_CATALOG) {
    const id = entry.definition.sloId;
    assert.equal(ids.indexOf(id), -1, `${id} is defined twice`);
    ids.push(id);
    const pair = `${entry.definition.metric}@${entry.definition.window}`;
    assert.equal(pairs.indexOf(pair), -1, `two SLOs page on ${pair}; one of them is noise`);
    pairs.push(pair);
  }
});

test('every metric in the contract vocabulary is either watched or explicitly exempt', () => {
  for (const metric of SHADOW_SLO_METRICS) {
    const watched = SHADOW_SLO_DEFINITIONS.filter((definition) => definition.metric === metric);
    const exemptions = SHADOW_SLO_METRIC_EXEMPTIONS.filter((entry) => entry.metric === metric);
    if (watched.length > 0) {
      assert.equal(exemptions.length, 0, `${metric} is both watched by an SLO and exempted`);
    } else {
      assert.equal(
        exemptions.length,
        1,
        `${metric} is neither watched by an SLO nor named once in the exemption list`,
      );
      assert.ok(exemptions[0].reason.length > 20, `${metric} is exempted without a reason`);
    }
  }
  for (const exemption of SHADOW_SLO_METRIC_EXEMPTIONS) {
    assert.ok(
      SHADOW_SLO_METRICS.indexOf(exemption.metric) !== -1,
      `${exemption.metric} is exempted and is not a metric`,
    );
  }
});

test('the sample-unit table is total over the metric vocabulary', () => {
  for (const metric of SHADOW_SLO_METRICS) {
    assert.ok(
      SHADOW_SLO_SAMPLE_UNIT[metric] === 'run' || SHADOW_SLO_SAMPLE_UNIT[metric] === 'module_run',
      `${metric} has no declared sample unit`,
    );
  }
});

/* ── Ownership: the acceptance criterion ─────────────────────────── */

test('every definition names a resolvable rotation and a different escalation', () => {
  for (const entry of SHADOW_SLO_CATALOG) {
    const owner = entry.definition.owner;
    const resolved = resolveShadowSloOwner(owner);
    assert.ok(resolved, `${entry.definition.sloId} names a rotation the router cannot resolve`);
    assert.equal(resolved.primary.rotationId, owner.rotationId);
    assert.equal(resolved.escalation.rotationId, owner.escalationRotationId);
    assert.notEqual(
      owner.escalationRotationId,
      owner.rotationId,
      `${entry.definition.sloId} escalates to the rotation that did not answer`,
    );
    assert.equal(resolved.primary.team, owner.team);
    assert.equal(resolved.escalation.team, owner.team);
    assert.equal(resolved.primary.kind, 'primary');
    assert.equal(resolved.escalation.kind, 'escalation');
  }
});

test('an owner naming a rotation nobody carries resolves to nothing', () => {
  const owner = entryFor('shadow-cost-micros-per-run').definition.owner;
  assert.equal(resolveShadowRotation('shadow-oncall-nobody'), null);
  assert.equal(resolveShadowSloOwner({ ...owner, rotationId: 'shadow-oncall-nobody' }), null);
  assert.equal(resolveShadowSloOwner({ ...owner, escalationRotationId: 'shadow-oncall-nobody' }), null);
  assert.equal(
    resolveShadowSloOwner({ ...owner, escalationRotationId: owner.rotationId }),
    null,
    'an escalation that leads back to the primary is not an escalation',
  );
  assert.equal(
    resolveShadowSloOwner({ ...owner, team: 'backend' }),
    null,
    'a definition whose declared team disagrees with the directory routes somewhere nobody has context',
  );
  assert.equal(
    resolveShadowSloOwner({
      ...owner,
      rotationId: 'shadow-oncall-product-lead',
      escalationRotationId: 'shadow-oncall-product',
    }),
    null,
    'a primary and an escalation cannot swap roles',
  );
});

test('every rotation has exactly one kind, which is what makes the equality check unnecessary', () => {
  for (const rotation of SHADOW_ONCALL_ROTATIONS) {
    const sameId = SHADOW_ONCALL_ROTATIONS.filter(
      (candidate) => candidate.rotationId === rotation.rotationId,
    );
    assert.equal(sameId.length, 1, `${rotation.rotationId} appears twice in the directory`);
    assert.ok(rotation.kind === 'primary' || rotation.kind === 'escalation', rotation.rotationId);
  }
  const primaries = SHADOW_ONCALL_ROTATIONS.filter((rotation) => rotation.kind === 'primary');
  const escalations = SHADOW_ONCALL_ROTATIONS.filter((rotation) => rotation.kind === 'escalation');
  assert.equal(primaries.length + escalations.length, SHADOW_ONCALL_ROTATIONS.length);
  for (const primary of primaries) {
    assert.equal(
      escalations.some((escalation) => escalation.rotationId === primary.rotationId),
      false,
      `${primary.rotationId} is both a primary and an escalation`,
    );
  }
});

test('every rotation in the directory is carried by at least one SLO', () => {
  for (const rotation of SHADOW_ONCALL_ROTATIONS) {
    const carriers = SHADOW_SLO_DEFINITIONS.filter(
      (definition) =>
        definition.owner.rotationId === rotation.rotationId ||
        definition.owner.escalationRotationId === rotation.rotationId,
    );
    assert.ok(
      carriers.length >= 1,
      `${rotation.rotationId} is on the roster and owns nothing; a rotation nobody pages is a rotation nobody staffs`,
    );
  }
});

test('a kill switch a definition arms names a real module', () => {
  for (const entry of SHADOW_SLO_CATALOG) {
    const module = entry.definition.killSwitchModule;
    if (module === null) continue;
    assert.ok(
      INTELLIGENCE_MODULES.indexOf(module) !== -1,
      `${entry.definition.sloId} arms a switch for ${module}`,
    );
  }
  assert.ok(
    SHADOW_SLO_DEFINITIONS.some((definition) => definition.killSwitchModule === null),
    'no definition answers null; the field stops being a question anyone asked',
  );
});

/* ── Per-site mutation: every threshold and every comparator ─────── */

test('every threshold is load-bearing on its own', () => {
  for (const expected of EXPECTED) {
    const definition = entryFor(expected.sloId).definition;
    const probe = justBreaching(definition, expected.step);

    assert.equal(
      shadowSloBreached(definition, definition.threshold),
      false,
      `${expected.sloId}: a value exactly at the threshold breaches; the comparison is inclusive of the wrong side`,
    );
    assert.equal(
      shadowSloBreached(definition, probe),
      true,
      `${expected.sloId}: a value one step past the threshold does not breach`,
    );

    const moved: ShadowSloDefinition = {
      ...definition,
      threshold: definition.comparison === 'at_most' ? probe : probe - expected.step,
    };
    assert.equal(
      shadowSloBreached(moved, probe),
      false,
      `${expected.sloId}: moving the threshold past the probe changes nothing, so the threshold is not read`,
    );
  }
});

test('every comparator is load-bearing on its own', () => {
  for (const expected of EXPECTED) {
    const definition = entryFor(expected.sloId).definition;
    const probe = justBreaching(definition, expected.step);
    const flipped: ShadowSloDefinition = {
      ...definition,
      comparison: definition.comparison === 'at_most' ? 'at_least' : 'at_most',
    };
    assert.equal(
      shadowSloBreached(flipped, probe),
      false,
      `${expected.sloId}: the same probe breaches in both directions, so the comparator is not read`,
    );
  }
});

/* ── Alert queries: evaluable functions, not strings ─────────────── */

test('an alert query is a function over readings and clears when nothing breaches', () => {
  const entry = entryFor('shadow-pipeline-withheld-rate');
  const query = shadowAlertQuery(entry);
  assert.equal(typeof query, 'function');
  const verdict = query([measured(entry.definition, 0, 40), measured(entry.definition, 0.01, 40)]);
  assert.equal(verdict.state, 'clear');
  assert.equal(verdict.notifyRotationId, null);
  assert.equal(verdict.consecutiveBreaches, 0);
  assert.equal(verdict.armsKillSwitchForModule, null);
});

test('one breach watches, a sustained breach pages, a longer one escalates', () => {
  const entry = entryFor('shadow-pipeline-latency-p95');
  const breaching = measured(entry.definition, 6001, 60);
  const clean = measured(entry.definition, 3450, 60);
  assert.equal(entry.pageAfterConsecutiveBreaches, 2);
  assert.equal(entry.escalateAfterConsecutiveBreaches, 3);

  const watch = evaluateShadowAlert(entry, [clean, breaching]);
  assert.equal(watch.state, 'watch');
  assert.equal(watch.notifyRotationId, null);
  assert.equal(watch.consecutiveBreaches, 1);

  const paging = evaluateShadowAlert(entry, [clean, breaching, breaching]);
  assert.equal(paging.state, 'paging');
  assert.equal(paging.notifyRotationId, 'shadow-oncall-backend');
  assert.equal(paging.escalated, false);
  assert.equal(paging.armsKillSwitchForModule, 'coaching');

  const escalated = evaluateShadowAlert(entry, [breaching, breaching, breaching]);
  assert.equal(escalated.state, 'paging');
  assert.equal(escalated.escalated, true);
  assert.equal(escalated.notifyRotationId, 'shadow-oncall-backend-lead');
});

test('a clean reading after breaches resets the run rather than being averaged in', () => {
  const entry = entryFor('shadow-pipeline-latency-p95');
  const breaching = measured(entry.definition, 6001, 60);
  const clean = measured(entry.definition, 3450, 60);
  const verdict = evaluateShadowAlert(entry, [breaching, breaching, breaching, clean]);
  assert.equal(verdict.state, 'clear');
  assert.equal(verdict.consecutiveBreaches, 0);
});

test('every rule escalates strictly later than it pages', () => {
  for (const entry of SHADOW_SLO_CATALOG) {
    assert.ok(entry.pageAfterConsecutiveBreaches >= 1, entry.definition.sloId);
    assert.ok(
      entry.escalateAfterConsecutiveBreaches > entry.pageAfterConsecutiveBreaches,
      `${entry.definition.sloId} escalates at the same breach count it pages at`,
    );
  }
});

test('an inconclusive reading is undetermined, never clear', () => {
  const entry = entryFor('shadow-replay-divergence-rate');
  for (const reason of ['insufficient_sample', 'no_data_in_window'] as const) {
    const verdict = evaluateShadowAlert(entry, [inconclusive(entry.definition, reason, 4)]);
    assert.equal(verdict.state, 'undetermined', reason);
    assert.equal(verdict.undeterminedReason, reason);
    assert.equal(verdict.notifyRotationId, null, reason);
    assert.equal(verdict.consecutiveBreaches, 0, reason);
  }
});

test('a collector that stopped answering pages the owner rather than reading as clear', () => {
  const entry = entryFor('shadow-replay-divergence-rate');
  const verdict = evaluateShadowAlert(entry, [
    measured(entry.definition, 0, 40),
    inconclusive(entry.definition, 'collector_unavailable'),
  ]);
  assert.equal(verdict.state, 'undetermined');
  assert.equal(verdict.undeterminedReason, 'collector_unavailable');
  assert.equal(verdict.notifyRotationId, 'shadow-oncall-quality');
});

test('a reading the contract rejects never reads as clear', () => {
  const entry = entryFor('shadow-safety-block-rate');
  const good = measured(entry.definition, 0.01, 60);
  const belowFloor: ShadowSloReading = { ...good, sampleCount: 4 } as ShadowSloReading;
  assert.ok(checkShadowSloReading(belowFloor, entry.definition).length > 0);
  const verdict = evaluateShadowAlert(entry, [belowFloor]);
  assert.equal(verdict.state, 'undetermined');
  assert.equal(verdict.undeterminedReason, 'reading_defective');
  assert.equal(verdict.notifyRotationId, 'shadow-oncall-quality');
});

test('a reading about another SLO is refused rather than counted', () => {
  const entry = entryFor('shadow-safety-block-rate');
  const other = entryFor('shadow-cost-micros-per-run');
  const verdict = evaluateShadowAlert(entry, [measured(other.definition, 10, 60)]);
  assert.equal(verdict.state, 'undetermined');
  assert.equal(verdict.undeterminedReason, 'reading_for_another_slo');
  assert.equal(verdict.notifyRotationId, 'shadow-oncall-quality');
});

test('no readings at all is undetermined and pages nobody', () => {
  const entry = entryFor('shadow-cost-micros-per-run');
  const verdict = evaluateShadowAlert(entry, []);
  assert.equal(verdict.state, 'undetermined');
  assert.equal(verdict.undeterminedReason, 'no_readings');
  assert.equal(verdict.notifyRotationId, null);
});

test('the window a reading spans is the window its definition declares', () => {
  for (const entry of SHADOW_SLO_CATALOG) {
    const reading = measured(entry.definition, entry.definition.threshold, entry.definition.minimumSampleCount);
    assert.deepEqual(
      checkShadowSloReading(reading, entry.definition),
      [],
      `${entry.definition.sloId} builds a reading its own definition rejects`,
    );
    assert.equal(
      SHADOW_SLO_WINDOW_MILLIS[entry.definition.window] > 0,
      true,
    );
  }
});
