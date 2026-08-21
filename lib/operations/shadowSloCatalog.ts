/**
 * The shadow pipeline's SLOs, their owners, and their alert queries (#46).
 *
 * The issue names five things that must be visible before any controlled
 * exposure — reliability, drift, safety, latency, cost — and this file is the
 * whole of #46's answer to "which SLO covers which". `ShadowSloConcern` is that
 * list as a closed type, every catalog entry declares one, and
 * `tests/operations/shadowSloCatalog.test.ts` enumerates the five against the
 * catalog so a concern that loses its SLO fails a test rather than being
 * noticed by nobody in six weeks.
 *
 * **Alert queries are functions, not strings.** `shadowAlertQuery` returns a
 * `(readings) => ShadowAlertVerdict`, so a query is type-checked against the
 * reading union, is exercised by tests, and cannot be a line of pseudo-SQL in a
 * runbook that no longer parses. Three decisions inside it are worth stating
 * here because they are the difference between an alert and a decoration:
 *
 *  1. **There is no boolean.** The verdict has four states, and `undetermined`
 *     is not `clear`. An `inconclusive` reading carries no value in the type;
 *     folding it into "not breached" would rebuild exactly the dashboard the
 *     contract's reading union exists to prevent — the one that renders 0% for
 *     "we have three data points" and gets a rollback decision taken on it.
 *  2. **`collector_unavailable` pages and the other two inconclusive reasons do
 *     not.** "Nothing happened" and "we could not look" are different facts;
 *     only the second is itself an incident, and the contract separates them so
 *     that this distinction is available to make.
 *  3. **A reading the contract's own checker rejects pages the owner.** A
 *     malformed reading that quietly evaluated to `clear` would make the alert
 *     pass exactly when the collector broke, which is the fail-open
 *     `shadowSloBreached` returns null to avoid.
 *
 * Nothing here reads a clock, sorts with a comparator, or generates anything.
 * A verdict is a pure function of the readings it is handed, in the order it is
 * handed them (oldest first, newest last — the collector's emission order, not
 * a sort this file would have to own).
 */

import {
  INTELLIGENCE_MODULES,
  type IntelligenceModuleName,
} from '../../src/contracts/v1/moduleContracts';
import {
  SHADOW_PIPELINE_CONTRACT_VERSION,
  SHADOW_PIPELINE_SCHEMA_VERSION,
  checkShadowSloReading,
  shadowSloBreached,
  type ShadowSloDefinition,
  type ShadowSloInconclusiveReason,
  type ShadowSloMetric,
  type ShadowSloOwner,
  type ShadowSloOwnerTeam,
  type ShadowSloReading,
} from '../../src/contracts/v1/shadowPipelineContracts';

/* ── The five concerns ───────────────────────────────────────────── */

/**
 * The five things #46 exists to make visible, as a closed vocabulary.
 *
 * Not derived from the catalog: derived from the issue. A list computed from
 * the definitions would be satisfied by any set of definitions, including the
 * empty one, which is the shape of coverage that reports 100% because it
 * measured itself.
 */
export type ShadowSloConcern = 'reliability' | 'drift' | 'safety' | 'latency' | 'cost';

export const SHADOW_SLO_CONCERNS = Object.freeze([
  'reliability',
  'drift',
  'safety',
  'latency',
  'cost',
] as const) satisfies readonly ShadowSloConcern[];

/* ── Who is woken up ─────────────────────────────────────────────── */

/**
 * The rotation directory the router resolves an owner against.
 *
 * The acceptance criterion is "alert ownership is explicit", and a
 * `ShadowSloOwner` alone satisfies half of it: it proves the definition *names*
 * a rotation. This table is the other half — it proves the name resolves to
 * somebody, which is the difference between an alert and the appearance of one.
 * `resolveShadowSloOwner` returns null rather than throwing so a caller that
 * wants to report every unroutable definition can, and every rotation here is
 * held to being carried by at least one SLO by the test: a rotation on the
 * roster that owns nothing is a rotation nobody staffs.
 */
export interface ShadowOncallRotation {
  readonly rotationId: string;
  readonly team: ShadowSloOwnerTeam;
  readonly kind: 'primary' | 'escalation';
  /** Where the page lands. A channel code, never an address. */
  readonly channelCode: string;
}

export const SHADOW_ONCALL_ROTATIONS: readonly ShadowOncallRotation[] = Object.freeze([
  Object.freeze({
    rotationId: 'shadow-oncall-backend',
    team: 'backend' as const,
    kind: 'primary' as const,
    channelCode: 'page-backend-primary',
  }),
  Object.freeze({
    rotationId: 'shadow-oncall-backend-lead',
    team: 'backend' as const,
    kind: 'escalation' as const,
    channelCode: 'page-backend-lead',
  }),
  Object.freeze({
    rotationId: 'shadow-oncall-quality',
    team: 'quality' as const,
    kind: 'primary' as const,
    channelCode: 'page-quality-primary',
  }),
  Object.freeze({
    rotationId: 'shadow-oncall-quality-lead',
    team: 'quality' as const,
    kind: 'escalation' as const,
    channelCode: 'page-quality-lead',
  }),
  Object.freeze({
    rotationId: 'shadow-oncall-product',
    team: 'product' as const,
    kind: 'primary' as const,
    channelCode: 'page-product-primary',
  }),
  Object.freeze({
    rotationId: 'shadow-oncall-product-lead',
    team: 'product' as const,
    kind: 'escalation' as const,
    channelCode: 'page-product-lead',
  }),
]);

export function resolveShadowRotation(rotationId: string): ShadowOncallRotation | null {
  for (const rotation of SHADOW_ONCALL_ROTATIONS) {
    if (rotation.rotationId === rotationId) return rotation;
  }
  return null;
}

export interface ShadowResolvedOwner {
  readonly primary: ShadowOncallRotation;
  readonly escalation: ShadowOncallRotation;
}

/**
 * Resolve an owner to two rotations, or to nothing.
 *
 * Null for four separate failures, and they are all the same failure from the
 * on-call engineer's side: nobody comes. An unknown primary, an unknown
 * escalation, a team the directory disagrees with — a page routed into another
 * team's roster arrives somewhere nobody has context, which reads as coverage
 * and is not — and a pair whose kinds are wrong.
 *
 * **There is deliberately no separate `rotationId === escalationRotationId`
 * check**, and the omission is the reasoned one rather than the forgotten one:
 * a rotation id resolves to exactly one directory entry with exactly one
 * `kind`, so two equal ids cannot satisfy `primary` and `escalation` at once
 * and the kind check already refuses them. A mutation sweep found the equality
 * check masked by the kind check — deletable with no test moving — which is the
 * shape this repo removes rather than keeps. `every rotation has exactly one
 * kind` is the test that keeps the argument true.
 */
export function resolveShadowSloOwner(owner: ShadowSloOwner): ShadowResolvedOwner | null {
  const primary = resolveShadowRotation(owner.rotationId);
  const escalation = resolveShadowRotation(owner.escalationRotationId);
  if (primary === null || escalation === null) return null;
  if (primary.team !== owner.team || escalation.team !== owner.team) return null;
  if (primary.kind !== 'primary' || escalation.kind !== 'escalation') return null;
  return { primary, escalation };
}

/* ── Sample units ────────────────────────────────────────────────── */

/**
 * What one sample of each metric *is*.
 *
 * Total over the metric vocabulary, so a metric added to the contract without a
 * unit fails to typecheck here rather than being counted in whatever unit the
 * first collector assumed. The distinction is load-bearing for the sample
 * floor: `MIN_SLO_SAMPLE_COUNT` is twenty **samples**, and twenty module
 * executions is two and a half runs, so a `module_run` metric that declared a
 * floor of twenty would satisfy the contract's floor while resting on almost
 * nothing. The catalog scales those floors by the chain length and the test
 * holds them to it.
 */
export const SHADOW_SLO_SAMPLE_UNIT: Readonly<Record<ShadowSloMetric, 'run' | 'module_run'>> =
  Object.freeze({
    pipeline_latency_p95_ms: 'run',
    module_timeout_rate: 'module_run',
    module_fallback_rate: 'module_run',
    pipeline_degraded_rate: 'run',
    pipeline_withheld_rate: 'run',
    safety_block_rate: 'run',
    replay_divergence_rate: 'run',
    trace_completeness_rate: 'run',
    shadow_cost_micros_per_run: 'run',
  });

/**
 * The metrics this sprint deliberately does **not** page on, with the reason.
 *
 * Stated as data rather than omitted, because an unwatched metric and a metric
 * nobody thought about look identical from outside. The test demands that every
 * member of `SHADOW_SLO_METRICS` is either watched by a definition or named
 * here — so a tenth metric added to the contract arrives as a failing test.
 */
export const SHADOW_SLO_METRIC_EXEMPTIONS: readonly {
  readonly metric: ShadowSloMetric;
  readonly reason: string;
}[] = Object.freeze([
  Object.freeze({
    metric: 'pipeline_degraded_rate' as const,
    reason:
      'priority is a placeholder in SHADOW_MODULE_ROLES, so no Sprint 11 run can be complete and this rate is 1.0 by construction; an SLO on it would page continuously and be silenced in week one',
  }),
  Object.freeze({
    metric: 'module_fallback_rate' as const,
    reason:
      'a fallback is the kill switch working; paging on this rate would page the on-call engineer for their own mitigation, and the rate that matters after a switch is thrown is the timeout rate it was thrown to fix',
  }),
]);

/* ── The catalog ─────────────────────────────────────────────────── */

export interface ShadowSloCatalogEntry {
  readonly concern: ShadowSloConcern;
  readonly definition: ShadowSloDefinition;
  /** Consecutive breaching readings before the primary rotation is paged. */
  readonly pageAfterConsecutiveBreaches: number;
  /** Consecutive breaching readings before the escalation rotation is paged. */
  readonly escalateAfterConsecutiveBreaches: number;
  /** Why this threshold and not another. Read by the runbook generator. */
  readonly rationale: string;
}

const BACKEND: ShadowSloOwner = Object.freeze({
  team: 'backend' as const,
  rotationId: 'shadow-oncall-backend',
  escalationRotationId: 'shadow-oncall-backend-lead',
});

const QUALITY: ShadowSloOwner = Object.freeze({
  team: 'quality' as const,
  rotationId: 'shadow-oncall-quality',
  escalationRotationId: 'shadow-oncall-quality-lead',
});

const PRODUCT: ShadowSloOwner = Object.freeze({
  team: 'product' as const,
  rotationId: 'shadow-oncall-product',
  escalationRotationId: 'shadow-oncall-product-lead',
});

function definition(
  fields: Omit<ShadowSloDefinition, 'version' | 'schemaVersion'>,
): ShadowSloDefinition {
  return Object.freeze({
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    ...fields,
  });
}

export const SHADOW_SLO_CATALOG: readonly ShadowSloCatalogEntry[] = Object.freeze([
  Object.freeze({
    concern: 'reliability' as const,
    definition: definition({
      sloId: 'shadow-pipeline-withheld-rate',
      metric: 'pipeline_withheld_rate',
      comparison: 'at_most',
      threshold: 0.05,
      window: 'rolling_1h',
      minimumSampleCount: 20,
      owner: BACKEND,
      killSwitchModule: 'safety',
    }),
    pageAfterConsecutiveBreaches: 1,
    escalateAfterConsecutiveBreaches: 2,
    rationale:
      'A withheld run produced nothing at all. Five percent is the point at which the shadow corpus stops being large enough to judge quality from, and the switch it arms is safety: the gate is the only fail_closed module, and throwing its switch converts "the gate did not answer" into "the gate answered rules-only", which is a contribution rather than a withheld run.',
  }),
  Object.freeze({
    concern: 'reliability' as const,
    definition: definition({
      sloId: 'shadow-module-timeout-rate',
      metric: 'module_timeout_rate',
      comparison: 'at_most',
      threshold: 0.02,
      window: 'rolling_1h',
      minimumSampleCount: 160,
      owner: BACKEND,
      killSwitchModule: 'coaching',
    }),
    pageAfterConsecutiveBreaches: 2,
    escalateAfterConsecutiveBreaches: 3,
    rationale:
      'Counted per module execution, so the floor is twenty runs worth of stages rather than twenty stages. Two percent of module executions abandoned at their budget is the level at which the per-module budgets are wrong rather than unlucky. It arms coaching because coaching holds the joint-largest budget and is the generative stage; rules-only removes the call that is timing out.',
  }),
  Object.freeze({
    concern: 'drift' as const,
    definition: definition({
      sloId: 'shadow-replay-divergence-rate',
      metric: 'replay_divergence_rate',
      comparison: 'at_most',
      threshold: 0.01,
      window: 'rolling_24h',
      minimumSampleCount: 20,
      owner: QUALITY,
      killSwitchModule: 'coaching',
    }),
    pageAfterConsecutiveBreaches: 1,
    escalateAfterConsecutiveBreaches: 2,
    rationale:
      'Drift is measured as replay disagreement: the same bundle, run again, reaching a different outcome. One percent over a day, because a shadow run whose replay diverges cannot support any claim made about the corpus it belongs to. It arms coaching for the same reason the timeout SLO does, from the other side: model execution is the only nondeterministic step in the chain, and rules-only makes a replay reproducible by construction.',
  }),
  Object.freeze({
    concern: 'safety' as const,
    definition: definition({
      sloId: 'shadow-safety-block-rate',
      metric: 'safety_block_rate',
      comparison: 'at_most',
      threshold: 0.1,
      window: 'rolling_24h',
      minimumSampleCount: 40,
      owner: QUALITY,
      killSwitchModule: 'coaching',
    }),
    pageAfterConsecutiveBreaches: 2,
    escalateAfterConsecutiveBreaches: 3,
    rationale:
      'Measured over runs that produced a deliverable, since a withheld run has no disposition to read. A rising block rate is the generative stage drifting into material the gate refuses, and the mitigation is to take the generative stage rules-only rather than to relax the gate. The direction this SLO cannot see — a gate that silently allows everything — is watched by shadow-trace-completeness-rate and by the safety suite, not here; that limit is stated in the runbook rather than left to be discovered.',
  }),
  Object.freeze({
    concern: 'safety' as const,
    definition: definition({
      sloId: 'shadow-trace-completeness-rate',
      metric: 'trace_completeness_rate',
      comparison: 'at_least',
      threshold: 0.99,
      window: 'rolling_1h',
      minimumSampleCount: 20,
      owner: QUALITY,
      killSwitchModule: null,
    }),
    pageAfterConsecutiveBreaches: 1,
    escalateAfterConsecutiveBreaches: 2,
    rationale:
      'The only at_least SLO in the set: a run whose trace does not reconcile with its outcome is a run nobody can show was gated, so the claim "safety ran" degrades to an assertion. It arms no kill switch, and the null is the honest answer rather than a gap — a kill switch takes a module rules-only, and no module going rules-only fixes an observability failure. The response is to stop the drill, which is a conversation and not a config value.',
  }),
  Object.freeze({
    concern: 'latency' as const,
    definition: definition({
      sloId: 'shadow-pipeline-latency-p95',
      metric: 'pipeline_latency_p95_ms',
      comparison: 'at_most',
      threshold: 6000,
      window: 'rolling_1h',
      minimumSampleCount: 50,
      owner: BACKEND,
      killSwitchModule: 'coaching',
    }),
    pageAfterConsecutiveBreaches: 2,
    escalateAfterConsecutiveBreaches: 3,
    rationale:
      'Six seconds at p95 against a declared ceiling of eight: the SLO has to fire while there is still headroom, because an SLO set at the ceiling can only fire after every run is already being abandoned. Fifty samples, because a p95 over twenty observations is the value of the second-slowest one.',
  }),
  Object.freeze({
    concern: 'cost' as const,
    definition: definition({
      sloId: 'shadow-cost-micros-per-run',
      metric: 'shadow_cost_micros_per_run',
      comparison: 'at_most',
      threshold: 2500,
      window: 'rolling_24h',
      minimumSampleCount: 50,
      owner: PRODUCT,
      killSwitchModule: null,
    }),
    pageAfterConsecutiveBreaches: 2,
    escalateAfterConsecutiveBreaches: 3,
    rationale:
      'The mean cost of a shadow run in micros, owned by product because a cost breach is a decision about how much evidence is worth buying and not an engineering failure. It arms no kill switch: no single module going rules-only is the right answer to "the shadow corpus costs more than planned", and pretending otherwise would put a budget conversation behind an engineering lever.',
  }),
]);

export const SHADOW_SLO_DEFINITIONS: readonly ShadowSloDefinition[] = Object.freeze(
  SHADOW_SLO_CATALOG.map((entry) => entry.definition),
);

export function shadowSloById(sloId: string): ShadowSloCatalogEntry | null {
  for (const entry of SHADOW_SLO_CATALOG) {
    if (entry.definition.sloId === sloId) return entry;
  }
  return null;
}

export function shadowSlosForConcern(
  concern: ShadowSloConcern,
): readonly ShadowSloCatalogEntry[] {
  return Object.freeze(SHADOW_SLO_CATALOG.filter((entry) => entry.concern === concern));
}

/* ── Alert queries ───────────────────────────────────────────────── */

export type ShadowAlertState = 'clear' | 'watch' | 'paging' | 'undetermined';

export const SHADOW_ALERT_STATES = Object.freeze([
  'clear',
  'watch',
  'paging',
  'undetermined',
] as const) satisfies readonly ShadowAlertState[];

/**
 * Why a query could not decide. The contract's three inconclusive reasons, plus
 * the three a *query* has and a reading does not.
 */
export type ShadowAlertUndeterminedReason =
  | ShadowSloInconclusiveReason
  | 'no_readings'
  | 'reading_for_another_slo'
  | 'reading_defective';

export interface ShadowAlertVerdict {
  readonly sloId: string;
  readonly concern: ShadowSloConcern;
  readonly state: ShadowAlertState;
  readonly consecutiveBreaches: number;
  /** The rotation this verdict pages, or null when it pages nobody. */
  readonly notifyRotationId: string | null;
  readonly escalated: boolean;
  readonly undeterminedReason: ShadowAlertUndeterminedReason | null;
  /** The switch a paging verdict arms. Null unless the state is `paging`. */
  readonly armsKillSwitchForModule: IntelligenceModuleName | null;
}

export type ShadowAlertQuery = (readings: readonly ShadowSloReading[]) => ShadowAlertVerdict;

function verdict(
  entry: ShadowSloCatalogEntry,
  fields: Omit<ShadowAlertVerdict, 'sloId' | 'concern'>,
): ShadowAlertVerdict {
  return Object.freeze({
    sloId: entry.definition.sloId,
    concern: entry.concern,
    ...fields,
  });
}

function undetermined(
  entry: ShadowSloCatalogEntry,
  reason: ShadowAlertUndeterminedReason,
  pages: boolean,
): ShadowAlertVerdict {
  return verdict(entry, {
    state: 'undetermined',
    consecutiveBreaches: 0,
    notifyRotationId: pages ? entry.definition.owner.rotationId : null,
    escalated: false,
    undeterminedReason: reason,
    armsKillSwitchForModule: null,
  });
}

/**
 * Evaluate one SLO's alert rule over a window of readings.
 *
 * Readings are taken in the order given — oldest first — because that is the
 * order a collector emits them in and because sorting them would require this
 * file to own a comparator, which the repo's ordering rules reserve to
 * `lib/planning/shared/compare.ts`.
 */
export function evaluateShadowAlert(
  entry: ShadowSloCatalogEntry,
  readings: readonly ShadowSloReading[],
): ShadowAlertVerdict {
  if (readings.length === 0) return undetermined(entry, 'no_readings', false);

  for (let index = 0; index < readings.length; index += 1) {
    const reading = readings[index];
    if (reading.sloId !== entry.definition.sloId) {
      return undetermined(entry, 'reading_for_another_slo', true);
    }
    if (checkShadowSloReading(reading, entry.definition, index).length > 0) {
      return undetermined(entry, 'reading_defective', true);
    }
  }

  const latest = readings[readings.length - 1];
  if (latest.status === 'inconclusive') {
    return undetermined(
      entry,
      latest.inconclusiveReason,
      latest.inconclusiveReason === 'collector_unavailable',
    );
  }

  let consecutiveBreaches = 0;
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    const reading = readings[index];
    if (reading.status !== 'measured') break;
    // Recomputed from the definition rather than read off `reading.breached`:
    // the stored field is a producer's claim, and `checkShadowSloReading` above
    // has already reported any disagreement between the two.
    if (shadowSloBreached(entry.definition, reading.value) !== true) break;
    consecutiveBreaches += 1;
  }

  if (consecutiveBreaches === 0) {
    return verdict(entry, {
      state: 'clear',
      consecutiveBreaches: 0,
      notifyRotationId: null,
      escalated: false,
      undeterminedReason: null,
      armsKillSwitchForModule: null,
    });
  }

  if (consecutiveBreaches < entry.pageAfterConsecutiveBreaches) {
    return verdict(entry, {
      state: 'watch',
      consecutiveBreaches,
      notifyRotationId: null,
      escalated: false,
      undeterminedReason: null,
      armsKillSwitchForModule: null,
    });
  }

  const escalated = consecutiveBreaches >= entry.escalateAfterConsecutiveBreaches;
  return verdict(entry, {
    state: 'paging',
    consecutiveBreaches,
    notifyRotationId: escalated
      ? entry.definition.owner.escalationRotationId
      : entry.definition.owner.rotationId,
    escalated,
    undeterminedReason: null,
    armsKillSwitchForModule: entry.definition.killSwitchModule,
  });
}

/** The same rule, curried into the function a dashboard holds onto. */
export function shadowAlertQuery(entry: ShadowSloCatalogEntry): ShadowAlertQuery {
  return (readings) => evaluateShadowAlert(entry, readings);
}

/** Every alert query, by `sloId`. */
export const SHADOW_ALERT_QUERIES: Readonly<Record<string, ShadowAlertQuery>> = Object.freeze(
  SHADOW_SLO_CATALOG.reduce<Record<string, ShadowAlertQuery>>((queries, entry) => {
    queries[entry.definition.sloId] = shadowAlertQuery(entry);
    return queries;
  }, {}),
);

/** Named so a caller can prove the module list it arms against is the shipped one. */
export const SHADOW_SLO_KILL_SWITCH_MODULES: readonly IntelligenceModuleName[] = Object.freeze(
  SHADOW_SLO_DEFINITIONS.map((slo) => slo.killSwitchModule).filter(
    (module): module is IntelligenceModuleName =>
      module !== null && INTELLIGENCE_MODULES.indexOf(module) !== -1,
  ),
);
