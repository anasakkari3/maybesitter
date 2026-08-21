/**
 * Staged exposure configuration (Sprint 11, issue #47).
 *
 * ── Built on `resolvePilotAccess`, not beside it ─────────────────
 *
 * This module owns no allowlist, no trust store and no kill switch. The
 * membership judgement is `lib/pilot/pilotAccess.resolvePilotAccess`'s and stays
 * there; what arrives here is its already-made `PilotExposureDecision`, and the
 * only thing this module can do with it is refuse *further*. That is the whole
 * enforcement of `SHADOW_EXPOSURE_POLICY.shadowExposureNeverExceedsPilot`: there
 * is no code path in this file that turns a `false` into a `true`.
 *
 * The stage cohort narrows again. It is a *subset* of who the pilot gate would
 * admit — the people this stage is actually configured for — and a participant
 * outside it is refused with `not_allowlisted`, the pilot vocabulary's own word,
 * rather than with a second spelling of "not eligible" that a support
 * conversation cannot resolve.
 *
 * ── Where the narrowing is applied, and why there ────────────────
 *
 * Cohort membership is checked **after** `resolveShadowExposure`, not folded
 * into the pilot decision before it. Folding it in would make the cohort check
 * outrank the stage check, so a granted participant at `shadow_only` — where the
 * cohort is necessarily empty, the cap being zero — would read as
 * `not_allowlisted` instead of `stage_is_shadow_only`. The contract's ordering
 * exists so that a refusal names the *most explanatory* reason; applying this
 * narrowing afterwards keeps it.
 *
 * ── No general release, structurally ─────────────────────────────
 *
 * There is no stage above `closed_pilot` to configure, because
 * `ShadowExposureStage` has no member for one. This module never invents a
 * stage, never widens a cap, and every cap it enforces comes from
 * `SHADOW_STAGE_PARTICIPANT_CAP`.
 *
 * ── No clock, no cache ───────────────────────────────────────────
 *
 * `at` is the caller's. Consent is read from the store on every call and never
 * memoised, which is what makes an opt-out land on the *next* read rather than
 * on the next process restart.
 */
import {
  SHADOW_EXPOSURE_STAGES,
  SHADOW_PILOT_STOP_REASONS,
  SHADOW_SAFE_CODE,
  SHADOW_STAGE_PARTICIPANT_CAP,
  SHADOW_STAGE_PARTICIPANT_FLOOR,
  resolveShadowExposure,
  type Instant,
  type ShadowExposureDecision,
  type ShadowExposureStage,
  type ShadowPilotDecision,
  type ShadowPipelineDefect,
  type ShadowPipelineDefectCode,
} from '../../src/contracts/v1/shadowPipelineContracts';
import type { PilotExposureDecision, PilotStopReason } from '../pilot/closedPilotControls';
import { resolvePilotAccess } from '../pilot/pilotAccess';
import type { ShadowStudyConsentStore } from './consentStore';

/**
 * The contract restates `PilotStopReason` because a contract may not import
 * `lib/`. This is the pin from the other side: if either list grows a member
 * the other does not have, one of these two assignments stops compiling.
 */
type _ShadowCoversPilot = PilotStopReason extends ShadowPilotDecision['reason'] ? true : never;
type _PilotCoversShadow = Exclude<ShadowPilotDecision['reason'], 'authorized'> extends PilotStopReason
  ? true
  : never;
const _shadowCoversPilot: _ShadowCoversPilot = true;
const _pilotCoversShadow: _PilotCoversShadow = true;
export const SHADOW_PILOT_REASON_COVERAGE = _shadowCoversPilot && _pilotCoversShadow;

/**
 * The pilot's decision, in the contract's shape.
 *
 * A copy rather than a cast, so this is a real conversion a test can watch, and
 * no reason is remapped on the way: a participant refused for `quiet_mode`
 * reads `quiet_mode` here too.
 */
export function toShadowPilotDecision(decision: PilotExposureDecision): ShadowPilotDecision {
  return { allowed: decision.allowed === true, reason: decision.reason };
}

/**
 * The shipped pilot gate, as the injectable this module takes.
 *
 * `resolvePilotAccess` throws for a participant id its own pattern rejects, and
 * reads `process.env` and the trust store. Both are wrapped here: a throw
 * becomes the fail-closed refusal, because "the gate crashed" must never read
 * as "the gate allowed".
 */
export function createPilotAccessResolver(): (participantId: string, at: Instant) => ShadowPilotDecision {
  return (participantId, at) => {
    try {
      return toShadowPilotDecision(resolvePilotAccess(participantId, at).decision);
    } catch {
      return { allowed: false, reason: 'not_allowlisted' };
    }
  };
}

/* ── Configuration ───────────────────────────────────────────────── */

export interface ShadowStageConfiguration {
  readonly stage: ShadowExposureStage;
  /** The people this stage is configured for. A subset of the pilot allowlist. */
  readonly cohort: readonly string[];
}

export interface ShadowExposurePort {
  readonly configuration: ShadowStageConfiguration;
  readonly consent: ShadowStudyConsentStore;
  readonly resolvePilot: (participantId: string, at: Instant) => ShadowPilotDecision;
}

function defect(code: ShadowPipelineDefectCode, detail: string): ShadowPipelineDefect {
  return {
    code,
    module: null,
    stagePosition: null,
    proposalIndex: null,
    evidenceIndex: null,
    pillar: null,
    limitName: null,
    detail,
  };
}

/**
 * Structural check over a stage configuration, before anybody is resolved
 * against it.
 *
 * Reports rather than throws, in the contract's vocabulary rather than a new
 * one: `parseClosedPilotAllowlist` throws for the same class of mistake and
 * that is the other side of the same seam — a configuration loaded from the
 * environment at boot wants a throw, a configuration edited through a tool
 * wants a list of what is wrong with it.
 */
export function checkStageConfiguration(
  configuration: ShadowStageConfiguration,
): readonly ShadowPipelineDefect[] {
  const defects: ShadowPipelineDefect[] = [];
  const stageKnown = (SHADOW_EXPOSURE_STAGES as readonly string[]).includes(configuration.stage);
  if (!stageKnown) {
    defects.push(defect('EXPOSURE_STAGE_UNKNOWN', `not an exposure stage: ${String(configuration.stage)}`));
  }

  const cohort = Array.isArray(configuration.cohort) ? configuration.cohort : null;
  if (cohort === null) {
    defects.push(defect('EXPOSURE_COHORT_INVALID', 'the configuration carries no cohort list'));
    return defects;
  }

  for (const participantId of cohort) {
    if (typeof participantId !== 'string' || !SHADOW_SAFE_CODE.test(participantId)) {
      defects.push(
        defect('EXPOSURE_PARTICIPANT_UNSAFE', `a cohort member is outside the safe-code pattern: ${String(participantId)}`),
      );
    }
  }
  if (new Set(cohort).size !== cohort.length) {
    defects.push(defect('EXPOSURE_COHORT_INVALID', 'the cohort lists the same participant more than once'));
  }

  if (!stageKnown) return defects;

  const cap = SHADOW_STAGE_PARTICIPANT_CAP[configuration.stage];
  const floor = SHADOW_STAGE_PARTICIPANT_FLOOR[configuration.stage];
  if (cohort.length > cap) {
    defects.push(
      defect(
        'EXPOSURE_COHORT_EXCEEDS_CAP',
        `the cohort holds ${cohort.length} participants; ${configuration.stage} admits ${cap}`,
      ),
    );
  }
  if (cohort.length > 0 && cohort.length < floor) {
    defects.push(
      defect(
        'EXPOSURE_COHORT_BELOW_STAGE_FLOOR',
        `the cohort holds ${cohort.length} participants; ${configuration.stage} is only meaningful at ${floor}`,
      ),
    );
  }
  return defects;
}

/* ── Resolution ──────────────────────────────────────────────────── */

/**
 * One participant's staged exposure decision, for the configuration this port
 * holds and the consent the store holds *now*.
 *
 * Nothing is cached. The consent read is a fresh call every time, which is the
 * mechanism behind "opting out takes effect on the next read": there is no
 * second place a stale `allowed: true` could be living.
 */
export function resolveStagedExposure(
  port: ShadowExposurePort,
  participantId: string,
  at: Instant,
): ShadowExposureDecision {
  const decision = resolveShadowExposure({
    participantId,
    stage: port.configuration.stage,
    cohortSize: port.configuration.cohort.length,
    pilotDecision: port.resolvePilot(participantId, at),
    consent: port.consent.read(participantId),
  });

  // The stage cohort narrows once more, and only narrows: an allowed decision
  // for somebody this stage is not configured for becomes a refusal, and a
  // refusal is never revisited.
  if (decision.allowed && !port.configuration.cohort.includes(participantId)) {
    return { ...decision, allowed: false, reason: 'not_allowlisted' };
  }
  return decision;
}

/** Every configured participant's decision, in cohort order. Nothing sorts. */
export function resolveCohortExposure(
  port: ShadowExposurePort,
  at: Instant,
): readonly ShadowExposureDecision[] {
  return port.configuration.cohort.map((participantId) => resolveStagedExposure(port, participantId, at));
}

/**
 * How many of a cohort are actually exposed, and how many are not.
 *
 * Counted from the decisions rather than from the cohort length, because the
 * number an exposure report should quote is the number of people the gate said
 * yes to, not the number configured.
 */
export interface ShadowExposureTally {
  readonly stage: ShadowExposureStage;
  readonly cap: number;
  readonly configuredCount: number;
  readonly exposedCount: number;
  readonly refusedCount: number;
}

export function tallyExposure(
  configuration: ShadowStageConfiguration,
  decisions: readonly ShadowExposureDecision[],
): ShadowExposureTally {
  const exposed = decisions.filter((decision) => decision.allowed).length;
  return {
    stage: configuration.stage,
    cap: SHADOW_STAGE_PARTICIPANT_CAP[configuration.stage] ?? 0,
    configuredCount: configuration.cohort.length,
    exposedCount: exposed,
    refusedCount: decisions.length - exposed,
  };
}

/** Re-exported so a caller enumerating stop reasons reads one list, not two. */
export { SHADOW_PILOT_STOP_REASONS };

/* ── Reading a configuration from the environment ────────────────── */

export const SHADOW_STAGE_ENV_VAR = 'MAYBESITTER_SHADOW_STAGE';
export const SHADOW_COHORT_ENV_VAR = 'MAYBESITTER_SHADOW_COHORT_IDS';

/**
 * The configured stage and cohort, read fail-closed.
 *
 * An unset or unrecognised stage is `shadow_only` — the stage that exposes
 * nobody and the one this sprint actually ships in. A typo in a deployment
 * variable must not be able to *widen* exposure, so there is no path here where
 * an unreadable value resolves to anything but the narrowest stage.
 *
 * At `shadow_only` the cohort is emptied regardless of what is configured,
 * because the stage's cap is zero: keeping a list there would create a
 * configuration whose own checker reports `EXPOSURE_COHORT_EXCEEDS_CAP` on
 * every boot, and an alert that always fires is an alert nobody reads.
 * `checkStageConfiguration` still has to be run on the result — this function
 * reads, it does not validate.
 */
export function readStageConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ShadowStageConfiguration {
  const rawStage = env[SHADOW_STAGE_ENV_VAR];
  const stage: ShadowExposureStage =
    typeof rawStage === 'string' && (SHADOW_EXPOSURE_STAGES as readonly string[]).includes(rawStage)
      ? (rawStage as ShadowExposureStage)
      : 'shadow_only';

  const cohort = (env[SHADOW_COHORT_ENV_VAR] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return { stage, cohort: stage === 'shadow_only' ? [] : cohort };
}
