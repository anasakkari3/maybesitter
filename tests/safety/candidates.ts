/**
 * Shared fixtures for the safety suites.
 *
 * One copy, deliberately. Sprint 06's recorded lesson is that two independent
 * implementations of a *judgement* check each other, while two independent
 * copies of *data* are a gap waiting for whichever caller falls into it — three
 * copies of one lexicon disagreed on 20 of 31 probed titles. `validators`,
 * `redTeam` and `safetyBoundaries` all judge the same baseline candidate, so the
 * baseline lives here and each suite mutates it rather than rebuilding it.
 *
 * The baseline is deliberately *clean*: `validateSafetyRequest` and
 * `validateSafetyCandidate` must both return an empty list for it. Every test
 * below then works by breaking exactly one thing, which is what makes a finding
 * attributable to the thing that was broken.
 */

import type { EvidenceGraph } from '../../src/contracts/v1/recommendationContracts.ts';
import type {
  SafetyCandidate,
  SafetyRequest,
} from '../../src/contracts/v1/safetyContracts.ts';

export const NOW = '2026-08-20T09:00:00Z';
export const DUE_AT = '2026-08-21T15:00:00Z';

/**
 * A graph `checkEvidenceGraph` accepts, whose single observation carries the due
 * instant the baseline candidate states.
 *
 * `n-due` is observed and `n-overdue` derives from it, so the fixture exercises
 * `resolveEvidenceRoots` walking an edge rather than trivially landing on a root
 * — a one-node graph would let a broken traversal pass.
 */
export function cleanGraph(): EvidenceGraph {
  return {
    nodes: [
      {
        kind: 'observed',
        nodeId: 'n-due',
        source: { kind: 'commitment', commitmentId: 'c-1', field: 'due_at' },
        claim: { kind: 'instant', value: DUE_AT },
        observedAt: '2026-08-20T08:00:00Z',
        valueFingerprint: 'fp-due-1',
      },
      {
        kind: 'derived',
        nodeId: 'n-soon',
        rule: 'DUE_SOON_FROM_DUE_AT',
        claim: { kind: 'category', value: 'due_today' },
        derivedFrom: ['n-due'],
      },
    ],
  };
}

export function cleanRequest(overrides: Partial<SafetyRequest> = {}): SafetyRequest {
  return {
    requestId: 'req-1',
    surface: 'coaching_message',
    now: NOW,
    inputs: [
      {
        inputId: 'in-1',
        origin: 'user_text',
        sensitivity: 'personal',
        declaredTrust: 'data',
        text: 'draft the quarterly summary before the review',
      },
    ],
    permittedSensitivity: 'personal',
    pressureBudget: {
      maxIntensity: 'low',
      minIntervalMinutes: 60,
      lastPressuredAt: null,
      consecutiveUnansweredCount: 0,
      maxConsecutiveUnanswered: 3,
    },
    ...overrides,
  };
}

export function cleanCandidate(overrides: Partial<SafetyCandidate> = {}): SafetyCandidate {
  return {
    candidateId: 'cand-1',
    surface: 'coaching_message',
    segments: [
      { role: 'body', text: 'The quarterly summary is the next thing with a deadline.' },
      { role: 'question', text: 'Would you like to start it now?' },
    ],
    claims: [
      {
        claimId: 'cl-1',
        kind: 'time',
        statedInstant: DUE_AT,
        supportedBy: ['n-due'],
      },
      {
        claimId: 'cl-2',
        kind: 'statement',
        statedInstant: null,
        supportedBy: ['n-soon'],
      },
    ],
    evidence: cleanGraph(),
    effects: [{ effectId: 'ef-1', kind: 'none', requiresConfirmation: false }],
    pressure: 'low',
    ...overrides,
  };
}
