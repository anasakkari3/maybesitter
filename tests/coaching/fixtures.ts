/**
 * Recommendation fixtures for the Sprint 09 coaching suite.
 *
 * Not a `.test.ts` file, on the same terms as `tests/recommendation/reviewFixtures.ts`:
 * it is a builder, and every fixture it produces is asserted defect-free by
 * `checkRecommendation` in `plannerPolicy.test.ts` before anything is derived
 * from it. Sprint 02's recorded failure was a fixture corpus that was *data
 * nothing executed*, and 91 tests passed while three modules disagreed about
 * what it meant. A builder whose output is run through the real checker cannot
 * drift that way.
 *
 * Everything is explicit and nothing reads a clock.
 */

import {
  RECOMMENDATION_CONTRACT_VERSION,
  RECOMMENDATION_SCHEMA_VERSION,
  bandForConfidence,
  type EvidenceNode,
  type EvidenceNodeId,
  type Instant,
  type ObservedEvidence,
  type Recommendation,
  type RecommendationOption,
  type SupportReasonCode,
} from '../../src/contracts/v1/recommendationContracts';

export const BASIS_AT = '2026-08-20T09:00:00Z' as Instant;
export const NOW = '2026-08-20T09:15:00Z' as Instant;
export const EXPIRES_AT = '2026-08-20T10:00:00Z' as Instant;

export function observed(nodeId: string, fingerprint: string): ObservedEvidence {
  return {
    kind: 'observed',
    nodeId,
    source: { kind: 'commitment', commitmentId: 'commitment-alpha', field: 'due_at' },
    claim: { kind: 'category', value: 'overdue' },
    observedAt: '2026-08-19T08:00:00Z' as Instant,
    valueFingerprint: fingerprint,
  };
}

/** Every observed node's current fingerprint, so staleness resolves fresh. */
export function fingerprintsFor(recommendation: Recommendation): Record<EvidenceNodeId, string | null> {
  const map: Record<EvidenceNodeId, string | null> = {};
  for (const node of recommendation.evidence.nodes) {
    if (node.kind === 'observed') map[node.nodeId] = node.valueFingerprint;
  }
  return map;
}

function option(index: number, commitmentId: string, code: SupportReasonCode, evidenceId: string, basisId: string): RecommendationOption {
  const value = 0.8;
  return {
    optionIndex: index,
    action: { kind: 'do_now', commitmentId },
    support: [{ code, supportedBy: [evidenceId], detail: `option ${index} rests on 1 node` }],
    confidence: { value, band: bandForConfidence(value) as 'high', basis: [basisId] },
  };
}

const BASE = {
  version: RECOMMENDATION_CONTRACT_VERSION,
  schema: RECOMMENDATION_SCHEMA_VERSION,
  recommendationId: 'rec-fixture-one',
  scopeId: 'scope-fixture-one',
  validity: { basisAt: BASIS_AT, expiresAt: EXPIRES_AT },
  inputDigest: 'digest-fixture-one',
} as const;

/**
 * A `sole_survivor` offer whose lead support reason carries `code`.
 *
 * The parameter is what makes the claim-kind producibility sweep possible: one
 * recommendation per member of `SUPPORT_REASON_CODES`, so every claim kind
 * `CLAIM_KIND_FOR_SUPPORT_REASON` licenses is actually produced by a real
 * planner run rather than asserted to be producible.
 */
export function soleSurvivor(code: SupportReasonCode = 'OVERDUE', confidenceValue = 0.8): Recommendation {
  const nodes: EvidenceNode[] = [observed('n-reason', 'fp-reason'), observed('n-basis', 'fp-basis')];
  const lead = option(0, 'commitment-alpha', code, 'n-reason', 'n-basis');
  return {
    ...BASE,
    outcome: 'offered',
    evidence: { nodes },
    options: {
      kind: 'sole_survivor',
      option: { ...lead, confidence: { value: confidenceValue, band: bandForConfidence(confidenceValue) as 'high', basis: ['n-basis'] } },
      excluded: [
        {
          action: { kind: 'do_now', commitmentId: 'commitment-beta' },
          exclusion: [{ code: 'LOWER_RANKED', supportedBy: ['n-reason'], detail: '1 candidate scored higher' }],
        },
      ],
    },
  };
}

/** A two-option `choice`, which is what `name_the_alternatives` is produced from. */
export function choiceOffer(): Recommendation {
  const nodes: EvidenceNode[] = [
    observed('n-reason', 'fp-reason'),
    observed('n-basis', 'fp-basis'),
    observed('n-reason-two', 'fp-reason-two'),
    observed('n-basis-two', 'fp-basis-two'),
  ];
  return {
    ...BASE,
    outcome: 'offered',
    evidence: { nodes },
    options: {
      kind: 'choice',
      options: [
        option(0, 'commitment-alpha', 'OVERDUE', 'n-reason', 'n-basis'),
        option(1, 'commitment-beta', 'HIGH_IMPORTANCE', 'n-reason-two', 'n-basis-two'),
      ],
      excluded: [],
    },
  };
}

/** An `only_candidate` offer, which is what the attestation source is produced from. */
export function onlyCandidate(): Recommendation {
  const nodes: EvidenceNode[] = [
    observed('n-reason', 'fp-reason'),
    observed('n-basis', 'fp-basis'),
    observed('n-attested', 'fp-attested'),
  ];
  return {
    ...BASE,
    outcome: 'offered',
    evidence: { nodes },
    options: {
      kind: 'only_candidate',
      option: option(0, 'commitment-alpha', 'ONLY_ELIGIBLE_ACTION', 'n-reason', 'n-basis'),
      attested: ['n-attested'],
    },
  };
}

/** A withheld verdict, which is what `explain_withholding` is produced from. */
export function withheld(): Recommendation {
  return {
    ...BASE,
    outcome: 'withheld',
    evidence: { nodes: [observed('n-empty', 'fp-empty')] },
    reasons: [{ code: 'NO_ELIGIBLE_CANDIDATE', supportedBy: ['n-empty'], detail: '0 candidates survived' }],
  };
}
