/**
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE
 *
 * Shared builders for the Sprint 05 calibration suites (#22).
 *
 * Every judgment these builders produce carries `synthetic_pipeline_proof`
 * provenance by default, and the default is not overridable to
 * `human_reviewed` by accident: `syntheticCorpus` hard-codes it. A test corpus
 * that could be relabelled human would be one keystroke away from becoming the
 * exact artefact Sprint 04's empty corpus exists to prevent — weights fitted to
 * preferences nobody expressed, wearing a provenance that says otherwise.
 *
 * The commitments are deliberately trivial: two or three signals each, chosen
 * so that a single weight axis decides the ordering. A pair whose outcome
 * depends on four interacting weights proves nothing about which weight the
 * sweep moved.
 */
import { extractPriorityFeatures } from '../../lib/priority/priorityFeatures.ts';
import type { Commitment, Priority, Reminder } from '../../src/domain/stateMachine.ts';
import type { PairwiseJudgment, PriorityReason, JudgmentVerdict } from '../../src/contracts/v1/priorityContracts.ts';
import type { JudgmentProvenance } from '../../src/contracts/v1/calibrationContracts.ts';
import type {
  CalibrationCorpus,
  CalibrationPair,
  CalibrationSubject,
  HardConstraintDeclaration,
} from '../../lib/priority/calibration/corpus.ts';

/** One fixed instant. Nothing in these fixtures reads the host clock. */
export const CAL_CLOCK = '2026-08-18T09:00:00.000Z';

export interface SubjectSpec {
  readonly id: string;
  readonly reason?: PriorityReason;
  readonly level?: Priority['level'];
  readonly source?: Priority['source'];
  /** Snoozed reminders, which is what `LatenessFeature.snoozedCount` counts. */
  readonly snoozes?: number;
  readonly postponed?: boolean;
}

export function subjectOf(spec: SubjectSpec): CalibrationSubject {
  const commitment: Commitment = {
    id: spec.id,
    kind: 'task',
    title: `commitment ${spec.id}`,
    description: null,
    person: null,
    status: 'active',
    priority: {
      level: spec.level ?? 'normal',
      source: spec.source ?? 'inferred',
      pressureAllowed: false,
      pressureLevel: 'none',
    },
    timeSpec: { kind: 'unscheduled', dueAt: null, remindAt: null, timezone: 'UTC' },
    currentAckState: spec.postponed === true ? 'postponed' : 'seen',
    postponedUntil: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    confirmedAt: '2026-08-01T00:00:00.000Z',
    completedAt: null,
    droppedAt: null,
  };

  const reminders: Reminder[] = [];
  for (let index = 0; index < (spec.snoozes ?? 0); index += 1) {
    reminders.push({
      id: `${spec.id}-snooze-${index + 1}`,
      commitmentId: spec.id,
      reminderType: 'check_in',
      scheduledFor: '2026-08-17T09:00:00.000Z',
      status: 'snoozed',
      requiresAction: true,
      deliveredAt: '2026-08-17T09:00:00.000Z',
      acknowledgedAt: null,
      snoozedUntil: '2026-08-18T21:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-17T09:00:00.000Z',
    });
  }

  return {
    commitmentId: spec.id,
    reason: spec.reason ?? 'active',
    features: extractPriorityFeatures({ commitment, reminders, now: CAL_CLOCK }),
  };
}

export function pairOf(spec: {
  pairId: string;
  slice?: string;
  left: SubjectSpec;
  right: SubjectSpec;
}): CalibrationPair {
  return {
    pairId: spec.pairId,
    slice: spec.slice ?? 'default',
    left: subjectOf(spec.left),
    right: subjectOf(spec.right),
  };
}

export function judgmentOf(spec: {
  pairId: string;
  pair?: CalibrationPair;
  leftCommitmentId?: string;
  rightCommitmentId?: string;
  verdict: JudgmentVerdict;
  annotatorId?: string;
}): PairwiseJudgment {
  return {
    pairId: spec.pairId,
    leftCommitmentId: spec.leftCommitmentId ?? spec.pair?.left.commitmentId ?? `${spec.pairId}-l`,
    rightCommitmentId: spec.rightCommitmentId ?? spec.pair?.right.commitmentId ?? `${spec.pairId}-r`,
    verdict: spec.verdict,
    annotatorId: spec.annotatorId ?? 'synthetic-annotator-1',
    rationale: 'synthetic pipeline proof; not a human judgment',
    judgedAt: CAL_CLOCK,
  };
}

/**
 * Always `synthetic_pipeline_proof`. See the header: this is the one field a
 * fixture must not be able to lie about.
 */
export function syntheticCorpus(spec: {
  pairs: readonly CalibrationPair[];
  judgments: readonly PairwiseJudgment[];
  hardConstraints?: readonly HardConstraintDeclaration[];
}): CalibrationCorpus {
  const provenance: JudgmentProvenance = 'synthetic_pipeline_proof';
  return {
    provenance,
    pairs: spec.pairs,
    judgments: spec.judgments,
    hardConstraints: spec.hardConstraints ?? [],
  };
}
