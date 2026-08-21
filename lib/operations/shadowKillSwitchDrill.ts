/**
 * The kill-switch sweep (#46, "kill switches are tested").
 *
 * One switch at a time, a whole fixture pipeline under each, and a typed case
 * per module saying what happened. The sweep exists as a function rather than
 * as a block of assertions in a test because the rollback drill runs it too:
 * "arm the switches the breaching SLO names, and check the run degrades the way
 * the runbook says it will" is a rollback step, and a step that re-implemented
 * the check would be a second opinion about what a thrown switch does.
 *
 * **Why one at a time is the whole design.** Throwing every switch and asserting
 * the run degraded proves that *a* switch is wired. It passes unchanged when
 * seven of the eight are dead. So each case additionally asserts the negative:
 * `otherModulesAffected` is the list of modules whose stage moved when it should
 * not have, and it must be empty. That is the same shape as the per-entry
 * lexicon sweeps in `tests/safety/validators.test.ts`, where a masked entry has
 * to fail rather than merely a deleted one.
 *
 * The switch is thrown through the environment and read by the shipped
 * `readRuntimeControls`, so what is being tested is the product's own control
 * plane and not a simulation of it.
 */

import {
  SHADOW_PIPELINE_CHAIN,
  checkShadowPipelineOutcome,
  checkShadowTrace,
  type Instant,
  type ShadowCompleteness,
  type ShadowModuleStatus,
  type ShadowPipelineDefect,
  type ShadowPipelineModule,
  type ShadowStageReason,
} from '../../src/contracts/v1/shadowPipelineContracts';
import type { RulesOnlyFallbackReason } from '../../src/contracts/v1/runtimeControls';
import {
  SHADOW_KILL_SWITCH_STANCE,
  killSwitchEnvKey,
  runShadowDrill,
  shadowDrillEnv,
  type ShadowKillSwitchStance,
} from './shadowDrillPipeline';

/** The status a module reaches when its switch is thrown, per stance. */
export function expectedStatusForStance(stance: ShadowKillSwitchStance): ShadowModuleStatus {
  return stance === 'skipped_no_fallback' ? 'skipped' : 'fell_back';
}

export interface ShadowKillSwitchCase {
  readonly module: ShadowPipelineModule;
  readonly stance: ShadowKillSwitchStance;
  readonly runId: string;
  readonly runtimeMode: 'enabled' | 'rules_only';
  readonly runtimeReason: RulesOnlyFallbackReason | null;
  /** True when the trace's own stage record names the switch as the reason. */
  readonly switchVisibleInTrace: boolean;
  readonly observedStatus: ShadowModuleStatus;
  readonly observedReason: ShadowStageReason | null;
  readonly contributed: boolean;
  /** True when the adapter took the model path despite the decision. */
  readonly modelExecuted: boolean;
  /** Modules other than this one whose stage names a switch. Must be empty. */
  readonly otherModulesAffected: readonly ShadowPipelineModule[];
  readonly completeness: ShadowCompleteness;
  readonly outcomeDefects: readonly ShadowPipelineDefect[];
  readonly traceDefects: readonly ShadowPipelineDefect[];
  readonly passed: boolean;
}

export interface ShadowKillSwitchSweepOptions {
  readonly startedAt: Instant;
  /**
   * Whether to actually throw the switch. False is the control arm: it runs the
   * identical sweep with every switch off, and every case must then report
   * `passed: false`. A sweep that passed with nothing thrown would be measuring
   * the fixture rather than the switch.
   */
  readonly throwSwitch?: boolean;
  readonly runIdPrefix?: string;
}

/**
 * Throw each module's switch in turn and report what the run did.
 *
 * Chain order, one case per module, no module visited twice — the order is
 * `SHADOW_PIPELINE_CHAIN`'s, never a sort.
 */
export async function sweepShadowKillSwitches(
  options: ShadowKillSwitchSweepOptions,
): Promise<readonly ShadowKillSwitchCase[]> {
  const thrown = options.throwSwitch !== false;
  const prefix = options.runIdPrefix ?? 'drill-killswitch';
  const cases: ShadowKillSwitchCase[] = [];

  for (const module of SHADOW_PIPELINE_CHAIN) {
    const runId = `${prefix}-${module}`;
    const env = thrown ? shadowDrillEnv({ [killSwitchEnvKey(module)]: 'true' }) : shadowDrillEnv();
    const result = await runShadowDrill({
      runId,
      scopeId: 'drill-scope',
      startedAt: options.startedAt,
      env,
    });

    const outcome = result.bundle.outcome;
    const stage = result.bundle.trace.stages.filter((candidate) => candidate.module === module)[0];
    const moduleOutcome = outcome.moduleOutcomes[module];
    const decision = stage === undefined ? null : stage.runtimeDecision;
    const invocation = result.invocations.filter((entry) => entry.module === module)[0];

    const otherModulesAffected = result.bundle.trace.stages
      .filter((candidate) => candidate.module !== module && candidate.reason === 'kill_switch_active')
      .map((candidate) => candidate.module);

    const outcomeDefects = checkShadowPipelineOutcome(outcome);
    const traceDefects = checkShadowTrace(result.bundle.trace, outcome);
    const stance = SHADOW_KILL_SWITCH_STANCE[module];
    const runtimeMode = decision === null ? 'enabled' : decision.mode;
    const runtimeReason =
      decision !== null && decision.mode === 'rules_only' ? decision.reason : null;
    const observedStatus = moduleOutcome === undefined ? 'unavailable' : moduleOutcome.status;
    const observedReason = stage === undefined ? null : stage.reason;
    const modelExecuted = invocation === undefined ? false : invocation.modelExecuted;

    const observed: Omit<ShadowKillSwitchCase, 'passed'> = {
      module,
      stance,
      runId,
      runtimeMode,
      runtimeReason,
      switchVisibleInTrace: observedReason === 'kill_switch_active',
      observedStatus,
      observedReason,
      contributed: moduleOutcome === undefined ? false : moduleOutcome.contributed,
      modelExecuted,
      otherModulesAffected: Object.freeze(otherModulesAffected),
      completeness: outcome.completeness,
      outcomeDefects,
      traceDefects,
    };

    cases.push({ ...observed, passed: shadowKillSwitchCasePassed(observed) });
  }

  return Object.freeze(cases);
}

/**
 * Whether one observed case is a pass, as a **pure predicate over a case
 * value** rather than a conjunction buried in the sweep.
 *
 * Written this way so each clause can be killed on its own: a test can hand it
 * a doctored case whose blast radius is non-empty, or whose adapter took the
 * model path, and demand `false`. Computed inside the loop, those two clauses
 * survived a mutation sweep — every field was asserted individually and the
 * verdict that combined them was not.
 */
export function shadowKillSwitchCasePassed(
  observed: Omit<ShadowKillSwitchCase, 'passed'>,
): boolean {
  return (
    observed.runtimeMode === 'rules_only' &&
    observed.runtimeReason === 'kill_switch_active' &&
    observed.switchVisibleInTrace &&
    observed.observedReason === 'kill_switch_active' &&
    observed.observedStatus === expectedStatusForStance(observed.stance) &&
    observed.modelExecuted === false &&
    observed.otherModulesAffected.length === 0 &&
    observed.outcomeDefects.length === 0 &&
    observed.traceDefects.length === 0
  );
}

/** True when every module in the chain degraded to its documented stance. */
export function shadowKillSwitchSweepPassed(
  cases: readonly ShadowKillSwitchCase[],
): boolean {
  return (
    cases.length === SHADOW_PIPELINE_CHAIN.length &&
    cases.every((drillCase) => drillCase.passed)
  );
}
