/**
 * Fixtures for the Sprint 08 recommendation review tests.
 *
 * One builder, shared by all three test files, following
 * `tests/calibration/calibrationFixtures.ts`. Three test files each hand-rolling
 * a `Recommendation` is three chances to build one that quietly does not satisfy
 * #33's invariants — and a test whose fixture is structurally defective passes
 * for the wrong reason, because `presentRecommendation` refuses to render a
 * defective recommendation and would return the "nothing to review" view that
 * some of these tests are checking *for*.
 *
 * `assertFixtureIsSound` below is the guard: every builder output is run through
 * #33's own `checkRecommendation` before any test uses it.
 *
 * The commitment and proposal ids are deliberately hostile. `SECRET_COMMITMENT`
 * is the shape of the leak Sprint 07 recorded — a `detail` string reading
 * `working window call-dr.cohen-about-the-biopsy` that passed a test which only
 * checked the commitment *title* was absent. Ids are free strings that people
 * fill with content, so the fixtures fill them with content and the tests assert
 * where that content is allowed to appear.
 */

import assert from 'node:assert/strict';
import { checkRecommendation } from '../../src/contracts/v1/recommendationContracts.ts';
import type {
  EvidenceGraph,
  OfferedRecommendation,
  Recommendation,
  RecommendationOption,
  WithheldRecommendation,
} from '../../src/contracts/v1/recommendationContracts.ts';

export const SECRET_COMMITMENT = 'call-dr.cohen-about-the-biopsy';
export const SECOND_COMMITMENT = 'file-the-insurance-appeal';
export const EXCLUDED_COMMITMENT = 'renew-the-parking-permit';
export const SECRET_PROPOSAL = 'proposal-about-the-biopsy-letter';
export const RECOMMENDATION_ID = 'rec-for-the-biopsy-week';

export const BASIS_AT = '2026-08-19T10:00:00.000Z';
export const EXPIRES_AT = '2026-08-19T11:00:00.000Z';
export const NOW = '2026-08-19T10:30:00.000Z';
export const AFTER_EXPIRY = '2026-08-19T11:30:00.000Z';

/**
 * Two observations and one derivation over them.
 *
 * The derived node matters: `whyThisNow` on the lead cites `derived-overdue`,
 * not the observation, so a presenter that read the reason's own `supportedBy`
 * ids and reported *their* kinds would have nothing to report — a derived node
 * has no `source`. Only a presenter that walks to the observed roots produces
 * `commitment`, which is what makes the explanation an explanation.
 */
export const EVIDENCE: EvidenceGraph = {
  nodes: [
    {
      kind: 'observed',
      nodeId: 'obs-due',
      source: { kind: 'commitment', commitmentId: SECRET_COMMITMENT, field: 'due_at' },
      claim: { kind: 'instant', value: '2026-08-19T09:00:00.000Z' },
      observedAt: '2026-08-19T08:00:00.000Z',
      valueFingerprint: 'fp-due-1',
    },
    {
      kind: 'observed',
      nodeId: 'obs-slot',
      source: { kind: 'plan_slot', itemId: SECOND_COMMITMENT, planDigest: 'plan-digest-1' },
      claim: { kind: 'instant', value: '2026-08-19T12:00:00.000Z' },
      observedAt: '2026-08-19T07:30:00.000Z',
      valueFingerprint: 'fp-slot-1',
    },
    {
      kind: 'observed',
      nodeId: 'obs-load',
      source: { kind: 'life_state_field', field: 'load', known: true },
      claim: { kind: 'category', value: 'load_moderate' },
      observedAt: null,
      valueFingerprint: 'fp-load-1',
    },
    {
      kind: 'derived',
      nodeId: 'derived-overdue',
      rule: 'OVERDUE_FROM_DUE_AT',
      claim: { kind: 'flag', value: true },
      derivedFrom: ['obs-due'],
    },
    {
      kind: 'derived',
      nodeId: 'derived-capacity',
      rule: 'CAPACITY_FROM_LOAD',
      claim: { kind: 'quantity', value: 45, unit: 'minutes' },
      derivedFrom: ['obs-load', 'obs-slot'],
    },
  ],
};

/** Every observed node's fingerprint, unchanged. The "still fresh" case. */
export const FRESH_FINGERPRINTS: Readonly<Record<string, string | null>> = Object.freeze({
  'obs-due': 'fp-due-1',
  'obs-slot': 'fp-slot-1',
  'obs-load': 'fp-load-1',
});

const LEAD_OPTION: RecommendationOption = {
  optionIndex: 0,
  action: { kind: 'do_now', commitmentId: SECRET_COMMITMENT },
  support: [
    { code: 'OVERDUE', supportedBy: ['derived-overdue'], detail: 'option #0 is past its stated time' },
    { code: 'HIGH_IMPORTANCE', supportedBy: ['obs-due'], detail: 'option #0 carries the highest stated importance' },
  ],
  confidence: { value: 0.82, band: 'high', basis: ['derived-overdue'] },
};

const SECOND_OPTION: RecommendationOption = {
  optionIndex: 1,
  action: {
    kind: 'schedule',
    commitmentId: SECOND_COMMITMENT,
    slot: { startsAt: '2026-08-19T12:00:00.000Z', endsAt: '2026-08-19T12:45:00.000Z' },
  },
  support: [
    { code: 'PLAN_SLOT_IMMINENT', supportedBy: ['derived-capacity'], detail: 'option #1 has a slot starting soon' },
  ],
  confidence: { value: 0.51, band: 'medium', basis: ['obs-slot'] },
};

const THIRD_OPTION: RecommendationOption = {
  optionIndex: 2,
  action: { kind: 'decompose', commitmentId: SECRET_COMMITMENT, proposalId: SECRET_PROPOSAL },
  support: [{ code: 'QUICK_WIN', supportedBy: ['obs-load'], detail: 'option #2 breaks into short steps' }],
  confidence: { value: 0.2, band: 'low', basis: ['obs-load'] },
};

/** A three-option `choice`. The variant that exercises the lead/alternatives split. */
export function offeredChoice(): OfferedRecommendation {
  return {
    version: 'v1',
    schema: 'recommendation-v1',
    recommendationId: RECOMMENDATION_ID,
    scopeId: 'scope-the-biopsy-week',
    validity: { basisAt: BASIS_AT, expiresAt: EXPIRES_AT },
    evidence: EVIDENCE,
    inputDigest: 'digest-1',
    outcome: 'offered',
    options: {
      kind: 'choice',
      options: [LEAD_OPTION, SECOND_OPTION, THIRD_OPTION],
      excluded: [
        {
          action: { kind: 'do_now', commitmentId: EXCLUDED_COMMITMENT },
          exclusion: [
            { code: 'LOWER_RANKED', supportedBy: ['obs-due'], detail: 'ranked below the three offered options' },
          ],
        },
      ],
    },
  } as OfferedRecommendation;
}

/**
 * The `sole_survivor` variant, with the non-empty exclusion account #33 requires.
 *
 * This is the variant the user-control acceptance criterion is actually about:
 * one option on screen with no context reads as an instruction.
 */
export function offeredSoleSurvivor(): OfferedRecommendation {
  return {
    ...offeredChoice(),
    options: {
      kind: 'sole_survivor',
      option: LEAD_OPTION,
      excluded: [
        {
          action: { kind: 'do_now', commitmentId: EXCLUDED_COMMITMENT },
          exclusion: [{ code: 'NOT_CONFIRMED', supportedBy: ['obs-due'], detail: 'not confirmed yet' }],
        },
      ],
    },
  } as OfferedRecommendation;
}

export function withheld(): WithheldRecommendation {
  return {
    version: 'v1',
    schema: 'recommendation-v1',
    recommendationId: RECOMMENDATION_ID,
    scopeId: 'scope-the-biopsy-week',
    validity: { basisAt: BASIS_AT, expiresAt: EXPIRES_AT },
    evidence: EVIDENCE,
    inputDigest: 'digest-1',
    outcome: 'withheld',
    reasons: [
      { code: 'ALL_CANDIDATES_EXCLUDED', supportedBy: ['obs-load'], detail: 'every candidate was excluded' },
    ],
  } as WithheldRecommendation;
}

/**
 * A recommendation with a stated band its confidence value does not map to.
 *
 * `CONFIDENCE_BAND_MISMATCH` rather than something cruder, because it is the
 * defect #33 says is invisible to both readers: ranking reads the number and the
 * UI reads the band. A presenter that rendered without checking would show
 * "High confidence" over a 0.1.
 */
export function offeredWithBandMismatch(): OfferedRecommendation {
  const base = offeredChoice();
  return {
    ...base,
    options: {
      kind: 'choice',
      options: [
        { ...LEAD_OPTION, confidence: { value: 0.1, band: 'high', basis: ['derived-overdue'] } },
        SECOND_OPTION,
      ],
      excluded: [],
    },
  } as OfferedRecommendation;
}

/** Assert a fixture satisfies #33's own structural checker before a test leans on it. */
export function assertFixtureIsSound(recommendation: Recommendation): void {
  assert.deepEqual(checkRecommendation(recommendation), []);
}

/**
 * Every path in `value` at which `needle` appears inside a string.
 *
 * Used by the redaction and id-leak tests. It walks the whole structure rather
 * than checking the fields the test author thought of, which is the difference
 * between this and the Sprint 07 test that checked only titles.
 */
export function pathsContaining(value: unknown, needle: string, prefix = '$'): readonly string[] {
  if (typeof value === 'string') return value.includes(needle) ? [prefix] : [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => pathsContaining(entry, needle, `${prefix}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => pathsContaining(entry, needle, `${prefix}.${key}`));
  }
  return [];
}

/** Every object key that appears anywhere in `value`, at any depth. */
export function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) allKeys(entry, into);
    return into;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      allKeys(entry, into);
    }
  }
  return into;
}
