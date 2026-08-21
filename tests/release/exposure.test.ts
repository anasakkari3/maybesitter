/**
 * Staged exposure: what the stages are, what they cannot be, and the one
 * direction the shadow gate is allowed to move the pilot gate in.
 *
 * Every cap and floor fixture below derives from the contract's constant, and
 * every constant is separately pinned against a literal and against the
 * `lib/pilot` bound it restates. A fixture that hard-coded 40 would keep
 * passing after somebody widened the pilot; a constant nobody pinned would let
 * the contract drift away from the parser that throws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHADOW_EXPOSURE_POLICY,
  SHADOW_EXPOSURE_REASONS,
  SHADOW_EXPOSURE_STAGES,
  SHADOW_PILOT_STOP_REASONS,
  SHADOW_STAGE_PARTICIPANT_CAP,
  SHADOW_STAGE_PARTICIPANT_FLOOR,
  checkShadowExposureDecision,
  type ShadowExposureStage,
  type ShadowPilotDecision,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { CLOSED_PILOT_MAXIMUM, CLOSED_PILOT_MINIMUM } from '../../lib/pilot/closedPilotControls.ts';
import { ALPHA_ALLOWLIST_MAXIMUM, ALPHA_ALLOWLIST_MINIMUM } from '../../lib/pilot/alphaControls.ts';
import { createInMemoryShadowStudyConsentStore } from '../../lib/release/consentStore.ts';
import {
  SHADOW_COHORT_ENV_VAR,
  SHADOW_STAGE_ENV_VAR,
  checkStageConfiguration,
  readStageConfiguration,
  resolveCohortExposure,
  resolveStagedExposure,
  toShadowPilotDecision,
  type ShadowExposurePort,
  type ShadowStageConfiguration,
} from '../../lib/release/exposure.ts';

const T1 = '2027-01-04T09:00:00.000Z';
const T2 = '2027-01-05T09:00:00.000Z';

const AUTHORIZED: ShadowPilotDecision = { allowed: true, reason: 'authorized' };

function cohortOf(size: number): string[] {
  return Array.from({ length: size }, (_unused, index) => `participant-${String(index).padStart(3, '0')}`);
}

function portFor(
  stage: ShadowExposureStage,
  cohort: readonly string[],
  pilot: ShadowPilotDecision = AUTHORIZED,
): ShadowExposurePort {
  return {
    configuration: { stage, cohort },
    consent: createInMemoryShadowStudyConsentStore(),
    resolvePilot: () => pilot,
  };
}

/* ── No general release is representable ─────────────────────────── */

test('the stage vocabulary has no general-release member, and the policy says so', () => {
  assert.deepEqual([...SHADOW_EXPOSURE_STAGES], ['shadow_only', 'internal_dogfood', 'closed_pilot']);
  assert.equal(SHADOW_EXPOSURE_POLICY.generalReleaseRepresentable, false);
  for (const stage of SHADOW_EXPOSURE_STAGES) {
    assert.ok(
      SHADOW_STAGE_PARTICIPANT_CAP[stage] <= CLOSED_PILOT_MAXIMUM,
      `${stage} admits more than the closed pilot's ceiling, which is general release by another name`,
    );
  }
});

test('no configuration of any stage can expose more people than the closed pilot admits', () => {
  for (const stage of SHADOW_EXPOSURE_STAGES) {
    const cap = SHADOW_STAGE_PARTICIPANT_CAP[stage];
    const port = portFor(stage, cohortOf(cap + 1));
    const defects = checkStageConfiguration(port.configuration);
    assert.ok(
      defects.some((defect) => defect.code === 'EXPOSURE_COHORT_EXCEEDS_CAP'),
      `${stage} accepted a cohort of ${cap + 1}`,
    );
  }
});

test('shadow_only exposes nobody, whatever they consented to', () => {
  // The cohort is empty because the stage's cap is zero: at `shadow_only` the
  // chain runs and nobody is exposed, so there is nobody to put in the cohort.
  const port = portFor('shadow_only', []);
  port.consent.grant('participant-a', ['shadow_execution', 'feedback_study', 'trace_retention'], T1);
  const decision = resolveStagedExposure(port, 'participant-a', T2);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'stage_is_shadow_only');
  assert.equal(SHADOW_EXPOSURE_POLICY.shadowOnlyExposesNobody, true);
  assert.deepEqual(checkShadowExposureDecision(decision, AUTHORIZED), []);
});

/* ── The caps and floors, pinned then derived from ───────────────── */

test('the caps and floors are the pilot bounds this contract restates', () => {
  assert.equal(SHADOW_STAGE_PARTICIPANT_CAP.shadow_only, 0);
  assert.equal(SHADOW_STAGE_PARTICIPANT_CAP.internal_dogfood, 10);
  assert.equal(SHADOW_STAGE_PARTICIPANT_CAP.closed_pilot, 40);
  assert.equal(SHADOW_STAGE_PARTICIPANT_FLOOR.shadow_only, 0);
  assert.equal(SHADOW_STAGE_PARTICIPANT_FLOOR.internal_dogfood, 1);
  assert.equal(SHADOW_STAGE_PARTICIPANT_FLOOR.closed_pilot, 25);

  assert.equal(SHADOW_STAGE_PARTICIPANT_CAP.closed_pilot, CLOSED_PILOT_MAXIMUM);
  assert.equal(SHADOW_STAGE_PARTICIPANT_FLOOR.closed_pilot, CLOSED_PILOT_MINIMUM);
  assert.equal(SHADOW_STAGE_PARTICIPANT_CAP.internal_dogfood, ALPHA_ALLOWLIST_MAXIMUM);
  assert.equal(SHADOW_STAGE_PARTICIPANT_FLOOR.internal_dogfood, ALPHA_ALLOWLIST_MINIMUM);
});

test('each stage cap is probed one site at a time, from the constant', () => {
  for (const stage of SHADOW_EXPOSURE_STAGES) {
    const cap = SHADOW_STAGE_PARTICIPANT_CAP[stage];
    const floor = SHADOW_STAGE_PARTICIPANT_FLOOR[stage];
    for (const [size, shouldExceed] of [[cap, false], [cap + 1, true]] as const) {
      const defects = checkStageConfiguration({ stage, cohort: cohortOf(size) });
      assert.equal(
        defects.some((defect) => defect.code === 'EXPOSURE_COHORT_EXCEEDS_CAP'),
        shouldExceed,
        `${stage} at a cohort of ${size} (cap ${cap})`,
      );
    }
    if (floor > 1) {
      const belowFloor = checkStageConfiguration({ stage, cohort: cohortOf(floor - 1) });
      assert.ok(
        belowFloor.some((defect) => defect.code === 'EXPOSURE_COHORT_BELOW_STAGE_FLOOR'),
        `${stage} accepted a cohort of ${floor - 1} below its floor of ${floor}`,
      );
      const atFloor = checkStageConfiguration({ stage, cohort: cohortOf(floor) });
      assert.equal(
        atFloor.some((defect) => defect.code === 'EXPOSURE_COHORT_BELOW_STAGE_FLOOR'),
        false,
        `${stage} refused a cohort exactly at its floor of ${floor}`,
      );
    }
  }
});

test('a configuration is refused for an unknown stage, a duplicate id, or an unsafe id', () => {
  const cases: [ShadowStageConfiguration, string][] = [
    [{ stage: 'general_availability' as never, cohort: ['participant-a'] }, 'EXPOSURE_STAGE_UNKNOWN'],
    [{ stage: 'internal_dogfood', cohort: ['participant-a', 'participant-a'] }, 'EXPOSURE_COHORT_INVALID'],
    [{ stage: 'internal_dogfood', cohort: ['Participant A'] }, 'EXPOSURE_PARTICIPANT_UNSAFE'],
  ];
  for (const [configuration, code] of cases) {
    const defects = checkStageConfiguration(configuration);
    assert.ok(defects.some((defect) => defect.code === code), `${code} was not reported for ${JSON.stringify(configuration)}`);
  }
});

/* ── The shadow gate narrows the pilot gate and never widens it ──── */

test('every pilot stop reason narrows the shadow decision, and none of them widens it', () => {
  for (const reason of SHADOW_PILOT_STOP_REASONS) {
    const pilot: ShadowPilotDecision = { allowed: false, reason };
    const port = portFor('closed_pilot', cohortOf(CLOSED_PILOT_MINIMUM), pilot);
    // Everything else is maximally permissive: full consent at a stage that
    // exposes people, a cohort inside its bounds.
    for (const participantId of port.configuration.cohort) {
      port.consent.grant(participantId, ['shadow_execution', 'feedback_study', 'trace_retention'], T1);
    }
    const decision = resolveStagedExposure(port, port.configuration.cohort[0], T2);
    assert.equal(decision.allowed, false, `${reason} was widened into an exposure`);
    assert.equal(decision.reason, reason, `${reason} was remapped to ${decision.reason}`);
    assert.ok((SHADOW_EXPOSURE_REASONS as readonly string[]).includes(decision.reason));
    assert.deepEqual(checkShadowExposureDecision(decision, pilot), []);
  }
});

test('the policy claim about narrowing is the one the sweep above proves', () => {
  assert.equal(SHADOW_EXPOSURE_POLICY.shadowExposureNeverExceedsPilot, true);
});

test('a pilot decision that refuses without naming a reason fails closed', () => {
  const pilot: ShadowPilotDecision = { allowed: false, reason: 'authorized' };
  const port = portFor('internal_dogfood', ['participant-a'], pilot);
  port.consent.grant('participant-a', ['shadow_execution'], T1);
  const decision = resolveStagedExposure(port, 'participant-a', T2);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'not_allowlisted');
});

test('a participant outside the configured cohort is refused even when the pilot gate admits them', () => {
  const port = portFor('internal_dogfood', ['participant-a']);
  port.consent.grant('participant-b', ['shadow_execution'], T1);
  const decision = resolveStagedExposure(port, 'participant-b', T2);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'not_allowlisted');
});

test('a PilotExposureDecision converts to the contract shape without remapping any reason', () => {
  for (const reason of SHADOW_PILOT_STOP_REASONS) {
    assert.deepEqual(toShadowPilotDecision({ allowed: false, reason }), { allowed: false, reason });
  }
  assert.deepEqual(toShadowPilotDecision({ allowed: true, reason: 'authorized' }), AUTHORIZED);
});

/* ── Consent gates exposure, and opting out lands on the next read ─ */

test('a granted participant inside the bounds is exposed, and the decision is structurally clean', () => {
  const cohort = cohortOf(ALPHA_ALLOWLIST_MAXIMUM);
  const port = portFor('internal_dogfood', cohort);
  for (const participantId of cohort) port.consent.grant(participantId, ['shadow_execution'], T1);
  const decision = resolveStagedExposure(port, cohort[0], T2);
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'authorized');
  assert.equal(decision.cap, SHADOW_STAGE_PARTICIPANT_CAP.internal_dogfood);
  assert.equal(decision.cohortSize, cohort.length);
  assert.equal(decision.consentState, 'granted');
  assert.deepEqual(checkShadowExposureDecision(decision, AUTHORIZED), []);
});

test('opting out takes effect on the very next read, with no exposure surviving it', () => {
  const port = portFor('internal_dogfood', ['participant-a']);
  port.consent.grant('participant-a', ['shadow_execution'], T1);
  const before = resolveStagedExposure(port, 'participant-a', T1);
  assert.equal(before.allowed, true);

  assert.equal(port.consent.revoke('participant-a', T2).status, 'written');

  const after = resolveStagedExposure(port, 'participant-a', T2);
  assert.equal(after.allowed, false, 'a cached exposure survived a revocation');
  assert.equal(after.reason, 'study_consent_revoked');
  assert.equal(after.consentState, 'revoked');
  // The earlier decision is a value, not a handle: it did not change, and it
  // is not what a later read returns.
  assert.equal(before.allowed, true);
  assert.notEqual(before, after);

  // And a third read, in case the second one was the thing doing the caching.
  assert.equal(resolveStagedExposure(port, 'participant-a', T2).allowed, false);
});

test('consent withheld and consent revoked are told apart, not folded into one refusal', () => {
  const port = portFor('internal_dogfood', ['participant-a', 'participant-b']);
  port.consent.grant('participant-b', ['shadow_execution'], T1);
  port.consent.revoke('participant-b', T2);

  assert.equal(resolveStagedExposure(port, 'participant-a', T2).reason, 'study_consent_withheld');
  assert.equal(resolveStagedExposure(port, 'participant-b', T2).reason, 'study_consent_revoked');
});

test('consenting to the study without consenting to shadow execution does not expose anyone', () => {
  const port = portFor('internal_dogfood', ['participant-a']);
  port.consent.grant('participant-a', ['feedback_study', 'trace_retention'], T1);
  const decision = resolveStagedExposure(port, 'participant-a', T2);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'study_consent_withheld');
});

test('a cohort resolves participant by participant, and one refusal does not refuse the rest', () => {
  const cohort = ['participant-a', 'participant-b', 'participant-c'];
  const port = portFor('internal_dogfood', cohort);
  port.consent.grant('participant-a', ['shadow_execution'], T1);
  port.consent.grant('participant-c', ['shadow_execution'], T1);

  const decisions = resolveCohortExposure(port, T2);
  assert.equal(decisions.length, cohort.length);
  // (participantId, allowed) pairs, in cohort order.
  assert.deepEqual(
    decisions.map((decision) => [decision.participantId, decision.allowed]),
    [['participant-a', true], ['participant-b', false], ['participant-c', true]],
  );
});

test('a cohort over its cap refuses every member for the cohort, not for the person', () => {
  const cap = SHADOW_STAGE_PARTICIPANT_CAP.internal_dogfood;
  const cohort = cohortOf(cap + 1);
  const port = portFor('internal_dogfood', cohort);
  for (const participantId of cohort) port.consent.grant(participantId, ['shadow_execution'], T1);
  for (const decision of resolveCohortExposure(port, T2)) {
    assert.equal(decision.allowed, false, `${decision.participantId} was exposed in an over-cap cohort`);
    assert.equal(decision.reason, 'stage_cap_exceeded');
  }
});

/* ── Reading the configuration from the environment ──────────────── */

test('an unset or unrecognised stage reads as the stage that exposes nobody', () => {
  for (const raw of [undefined, '', 'general_availability', 'GENERAL', 'closed pilot']) {
    const configuration = readStageConfiguration({ [SHADOW_STAGE_ENV_VAR]: raw } as unknown as NodeJS.ProcessEnv);
    assert.equal(configuration.stage, 'shadow_only', `${String(raw)} widened the stage`);
    assert.deepEqual(configuration.cohort, []);
  }
});

test('each recognised stage reads back as itself, one at a time', () => {
  for (const stage of SHADOW_EXPOSURE_STAGES) {
    const configuration = readStageConfiguration({
      [SHADOW_STAGE_ENV_VAR]: stage,
      [SHADOW_COHORT_ENV_VAR]: 'participant-a, participant-b',
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(configuration.stage, stage);
    assert.deepEqual(
      configuration.cohort,
      stage === 'shadow_only' ? [] : ['participant-a', 'participant-b'],
      `${stage} read the wrong cohort`,
    );
  }
});

test('a cohort of blanks and separators reads as no cohort at all', () => {
  const configuration = readStageConfiguration({
    [SHADOW_STAGE_ENV_VAR]: 'internal_dogfood',
    [SHADOW_COHORT_ENV_VAR]: ' , ,, ',
  } as unknown as NodeJS.ProcessEnv);
  assert.deepEqual(configuration.cohort, []);
});
