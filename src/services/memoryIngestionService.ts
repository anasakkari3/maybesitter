import { randomUUID } from 'crypto';
import type {
  MemoryCandidate,
  CommitmentMemoryStatus,
  CommitmentMemory,
  Observation,
  TimePrecision,
  CandidatePrecision,
} from '../domain/memory/memoryTypes.ts';
import { classifyCommitmentStatus, decideConfirmationLevel } from '../domain/memory/memoryPolicy.ts';
import { isTerminalStatus } from '../domain/memory/commitmentStateMachine.ts';
import { resolveCommitment, type ResolutionDecision } from '../domain/memory/commitmentResolver.ts';
import { extractCandidatesRuleBased } from '../extraction/ruleBasedCandidateExtractor.ts';
import { validateMemoryCandidate } from '../extraction/memoryCandidateSchema.ts';
import type { ObservationStore } from '../domain/memory/observationStore.ts';
import type { CommitmentMemoryStore } from '../domain/memory/commitmentMemoryStore.ts';

export interface IngestMessageInput {
  text: string;
  messageId?: string;
  userId: string;
  conversationId?: string;
  timestamp?: string;
}

export interface IngestionDecision {
  candidateType: string;
  modality: string;
  classifiedStatus: CommitmentMemoryStatus | null;
  confirmationLevel: string;
  resolution: ResolutionDecision;
  reason: string;
}

export interface IngestionResult {
  observation: Observation;
  candidates: MemoryCandidate[];
  decisions: IngestionDecision[];
  commitments: CommitmentMemory[];
  errors: string[];
}

export interface MemoryIngestionServiceDeps {
  observationStore: ObservationStore;
  commitmentStore: CommitmentMemoryStore;
}

function toTimePrecision(p: CandidatePrecision | undefined): TimePrecision {
  if (p === 'exact') return 'exact_time';
  if (p === 'approximate') return 'approximate_time';
  if (p === 'day') return 'day';
  return 'none';
}

export function ingestMessage(
  input: IngestMessageInput,
  deps: MemoryIngestionServiceDeps,
): IngestionResult {
  const now = input.timestamp || new Date().toISOString();
  const messageId = input.messageId || `msg_${randomUUID()}`;

  const observation = deps.observationStore.create({
    userId: input.userId,
    sourceText: input.text,
    sourceMessageId: messageId,
    sourceConversationId: input.conversationId,
    observedAt: now,
  });

  const candidates = extractCandidatesRuleBased(input.text, { now: new Date(now) });
  const validCandidates = candidates
    .map((c) => validateMemoryCandidate(c))
    .filter((c): c is MemoryCandidate => c !== null);

  const decisions: IngestionDecision[] = [];
  const commitments: CommitmentMemory[] = [];
  const errors: string[] = [];

  for (const candidate of validCandidates) {
    if (candidate.candidateType !== 'commitment') {
      decisions.push({
        candidateType: candidate.candidateType,
        modality: candidate.modality,
        classifiedStatus: null,
        confirmationLevel: 'none',
        resolution: { action: 'create_new' },
        reason: `Candidate type "${candidate.candidateType}" not handled in Sprint 1`,
      });
      continue;
    }

    const classifiedStatus = classifyCommitmentStatus(candidate);
    if (!classifiedStatus) {
      decisions.push({
        candidateType: candidate.candidateType,
        modality: candidate.modality,
        classifiedStatus: null,
        confirmationLevel: 'none',
        resolution: { action: 'create_new' },
        reason: `Modality "${candidate.modality}" yielded no commitment status (e.g., negation)`,
      });
      continue;
    }

    const confirmationLevel = decideConfirmationLevel(candidate);
    const openCommitments = deps.commitmentStore.getOpenByUserId(input.userId);
    const resolution = resolveCommitment(candidate, openCommitments);

    decisions.push({
      candidateType: candidate.candidateType,
      modality: candidate.modality,
      classifiedStatus,
      confirmationLevel,
      resolution,
      reason: resolutionReason(resolution),
    });

    try {
      if (resolution.action === 'link') {
        const existing = deps.commitmentStore.getById(resolution.commitmentId);
        if (existing && !isTerminalStatus(existing.status)) {
          const updated = deps.commitmentStore.update(
            {
              id: resolution.commitmentId,
              status: shouldUpgradeStatus(existing.status, classifiedStatus) ? classifiedStatus : undefined,
              dueAt: candidate.temporal?.resolvedAt || undefined,
              timePrecision: toTimePrecision(candidate.temporal?.precision),
              confidence: Math.max(existing.confidence, candidate.confidence),
              requiresConfirmation: confirmationLevel === 'hard_confirmation',
            },
            `Updated from message: "${candidate.evidenceSpan.text}"`,
            'model',
            observation.id,
          );
          deps.commitmentStore.addEvidence(resolution.commitmentId, observation.id);
          commitments.push(updated);
        }
      } else if (resolution.action === 'create_new') {
        const created = deps.commitmentStore.create(
          {
            userId: input.userId,
            title: candidate.normalizedText,
            status: classifiedStatus,
            dueAt: candidate.temporal?.resolvedAt,
            timePrecision: toTimePrecision(candidate.temporal?.precision),
            participants: [],
            confidence: candidate.confidence,
            evidenceIds: [observation.id],
            requiresConfirmation: confirmationLevel === 'hard_confirmation',
          },
          `Created from message: "${candidate.evidenceSpan.text}"`,
          observation.id,
        );
        commitments.push(created);
      } else if (resolution.action === 'confirm_link') {
        const created = deps.commitmentStore.create(
          {
            userId: input.userId,
            title: candidate.normalizedText,
            status: classifiedStatus,
            dueAt: candidate.temporal?.resolvedAt,
            timePrecision: toTimePrecision(candidate.temporal?.precision),
            participants: [],
            confidence: candidate.confidence,
            evidenceIds: [observation.id],
            requiresConfirmation: true,
            supersedesCommitmentId: resolution.commitmentId,
          },
          `Possibly related to ${resolution.commitmentId}, needs confirmation. Source: "${candidate.evidenceSpan.text}"`,
          observation.id,
        );
        commitments.push(created);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { observation, candidates: validCandidates, decisions, commitments, errors };
}

const STATUS_RANK: Record<CommitmentMemoryStatus, number> = {
  mentioned: 0,
  proposed: 1,
  confirmed: 2,
  scheduled: 3,
  postponed: 1,
  completed: 4,
  cancelled: 4,
  expired: 4,
};

function shouldUpgradeStatus(current: CommitmentMemoryStatus, candidate: CommitmentMemoryStatus): boolean {
  return STATUS_RANK[candidate] > STATUS_RANK[current];
}

function resolutionReason(resolution: ResolutionDecision): string {
  switch (resolution.action) {
    case 'link':
      return `Auto-linked to ${resolution.commitmentId} (score: ${resolution.score.totalScore.toFixed(2)}). Reasons: ${resolution.score.matchReasons.join(', ')}`;
    case 'confirm_link':
      return `Possibly linked to ${resolution.commitmentId} (score: ${resolution.score.totalScore.toFixed(2)}), needs confirmation. Reasons: ${resolution.score.matchReasons.join(', ')}`;
    case 'create_new':
      return 'No matching open commitment found, creating new';
  }
}
