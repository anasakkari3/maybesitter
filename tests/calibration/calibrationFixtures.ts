import type {
  AdjudicationRecord,
  AnnotationPolicyRegistry,
} from '../../lib/calibration/contracts.ts';
import type { PerItemAnnotation, ReviewDecision } from '../../lib/calibration/consistency.ts';

export const POLICIES: AnnotationPolicyRegistry = {
  contractVersion: '1.0.0',
  policies: [
    {
      id: 'capture-gold-annotation',
      version: '1.0.0',
      title: 'Overall completion',
      effectiveFrom: '2026-07-28T00:00:00.000Z',
      supersedes: null,
      summary: 'One overall completion per source; multi-commitment sources judged on the primary commitment.',
      changedRules: [],
    },
    {
      id: 'capture-gold-annotation',
      version: '2.0.0',
      title: 'Explicit per-item separation',
      effectiveFrom: '2026-07-29T01:00:00.000Z',
      supersedes: '1.0.0',
      summary: 'Multi-commitment sources require ordered per-item Gold.',
      changedRules: [
        {
          ruleId: 'MULTI-001',
          kind: 'changed',
          statement: 'A multi-commitment source may not be accepted as one combined completion.',
          affects: ['decision', 'commitment_count', 'boundary'],
        },
      ],
    },
    {
      id: 'capture-gold-annotation',
      version: '2.1.0',
      title: 'Temporal resolution',
      effectiveFrom: '2026-07-31T00:00:00.000Z',
      supersedes: '2.0.0',
      summary: 'Relative times resolve against the record reference_time.',
      changedRules: [
        {
          ruleId: 'TIME-001',
          kind: 'introduced',
          statement: 'Relative expressions resolve against reference_time, never the session clock.',
          affects: ['date_time'],
        },
      ],
    },
  ],
};

export function decision(
  sourceQueueId: string,
  value: string,
  completion: Record<string, unknown> | null = null,
): ReviewDecision {
  return { sourceQueueId, decision: value, completion };
}

export function adjudication(overrides: Partial<AdjudicationRecord> = {}): AdjudicationRecord {
  return {
    contractVersion: '1.0.0',
    sourceQueueId: 'src-a',
    dimension: 'decision',
    classification: 'reviewer_noise',
    canonicalPass: 'first',
    firstPassPolicy: '1.0.0',
    secondPassPolicy: '1.0.0',
    adjudicatedUnderPolicy: '2.1.0',
    rationale: 'The first pass preserved the named entity; the second dropped it.',
    adjudicatedBy: 'model-data track',
    adjudicatedAt: '2026-07-31T00:00:00.000Z',
    authorizingIssue: 'https://github.com/anasakkari3/maybesitter/issues/5',
    defectId: null,
    requiresReannotation: false,
    ...overrides,
  };
}

export function target(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'capture',
    title: 'Call Maya',
    person: null,
    dueAt: null,
    remindAt: null,
    localTimeSpec: null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    ...overrides,
  };
}

export function perItem(
  sourceQueueId: string,
  overrides: Partial<PerItemAnnotation> = {},
): PerItemAnnotation {
  return {
    sourceQueueId,
    reviewerId: 'anas',
    itemCount: 2,
    items: [
      { order: 0, sourceSegment: 'Call Maya', startCodePoint: 0, endCodePoint: 9, target: target() },
      {
        order: 1,
        sourceSegment: 'send the report',
        startCodePoint: 14,
        endCodePoint: 29,
        target: target({ title: 'Send the report' }),
      },
    ],
    ...overrides,
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
