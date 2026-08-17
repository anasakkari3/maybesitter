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
import { classifyPreferenceStrength, classifyPreferencePolarity, deriveStatementScope } from '../domain/memory/memoryPolicy.ts';
import { resolveStatement, type ResolvableStatement, type StatementResolutionDecision } from '../domain/memory/statementResolver.ts';
import type { PreferenceMemory, FactMemory } from '../domain/memory/memoryTypes.ts';
import type { PreferenceMemoryStore } from '../domain/memory/preferenceMemoryStore.ts';
import type { FactMemoryStore } from '../domain/memory/factMemoryStore.ts';

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
  resolution: ResolutionDecision | StatementResolutionDecision;
  reason: string;
}

export interface IngestionResult {
  observation: Observation;
  candidates: MemoryCandidate[];
  decisions: IngestionDecision[];
  commitments: CommitmentMemory[];
  preferences: PreferenceMemory[];
  facts: FactMemory[];
  errors: string[];
}

export interface MemoryIngestionServiceDeps {
  observationStore: ObservationStore;
  commitmentStore: CommitmentMemoryStore;
  preferenceStore: PreferenceMemoryStore;
  factStore: FactMemoryStore;
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
  const preferences: PreferenceMemory[] = [];
  const facts: FactMemory[] = [];
  const errors: string[] = [];

  for (const candidate of validCandidates) {
    if (candidate.candidateType === 'preference') {
      const scope = deriveStatementScope(candidate);
      const strength = classifyPreferenceStrength(candidate);
      const polarity = classifyPreferencePolarity(candidate);
      const existing: ResolvableStatement[] = deps.preferenceStore
        .getActiveByUserId(input.userId)
        .map((preference) => ({ id: preference.id, scope: preference.scope, statement: preference.statement }));
      const resolution = resolveStatement(scope, candidate.normalizedText, existing);

      decisions.push({
        candidateType: candidate.candidateType,
        modality: candidate.modality,
        classifiedStatus: null,
        confirmationLevel: 'none',
        resolution,
        reason: statementResolutionReason(resolution),
      });

      try {
        if (resolution.action === 'link') {
          const updated = deps.preferenceStore.update(
            { id: resolution.id, statement: candidate.normalizedText, strength, polarity, confidence: candidate.confidence },
            `Updated from message: "${candidate.evidenceSpan.text}"`,
            'model',
            observation.id,
          );
          deps.preferenceStore.addEvidence(resolution.id, observation.id);
          preferences.push(updated);
        } else {
          const created = deps.preferenceStore.create(
            {
              userId: input.userId,
              statement: candidate.normalizedText,
              scope,
              strength,
              polarity,
              confidence: candidate.confidence,
              evidenceIds: [observation.id],
              supersedesPreferenceId: resolution.action === 'confirm_link' ? resolution.id : undefined,
            },
            resolution.action === 'confirm_link'
              ? `Possibly related to ${resolution.id}, needs confirmation. Source: "${candidate.evidenceSpan.text}"`
              : `Created from message: "${candidate.evidenceSpan.text}"`,
            observation.id,
          );
          preferences.push(created);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      continue;
    }

    if (candidate.candidateType === 'fact') {
      const scope = deriveStatementScope(candidate);
      const existing: ResolvableStatement[] = deps.factStore
        .getActiveByUserId(input.userId)
        .map((fact) => ({ id: fact.id, scope: fact.scope, statement: fact.statement }));
      const resolution = resolveStatement(scope, candidate.normalizedText, existing);

      decisions.push({
        candidateType: candidate.candidateType,
        modality: candidate.modality,
        classifiedStatus: null,
        confirmationLevel: 'none',
        resolution,
        reason: statementResolutionReason(resolution),
      });

      try {
        if (resolution.action === 'link') {
          const updated = deps.factStore.update(
            { id: resolution.id, statement: candidate.normalizedText, confidence: candidate.confidence },
            `Updated from message: "${candidate.evidenceSpan.text}"`,
            'model',
            observation.id,
          );
          deps.factStore.addEvidence(resolution.id, observation.id);
          facts.push(updated);
        } else {
          const created = deps.factStore.create(
            {
              userId: input.userId,
              statement: candidate.normalizedText,
              scope,
              confidence: candidate.confidence,
              evidenceIds: [observation.id],
              supersedesFactId: resolution.action === 'confirm_link' ? resolution.id : undefined,
            },
            resolution.action === 'confirm_link'
              ? `Possibly related to ${resolution.id}, needs confirmation. Source: "${candidate.evidenceSpan.text}"`
              : `Created from message: "${candidate.evidenceSpan.text}"`,
            observation.id,
          );
          facts.push(created);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      continue;
    }

    if (candidate.candidateType !== 'commitment') {
      decisions.push({
        candidateType: candidate.candidateType,
        modality: candidate.modality,
        classifiedStatus: null,
        confirmationLevel: 'none',
        resolution: { action: 'create_new' },
        reason: `Candidate type "${candidate.candidateType}" not handled`,
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

  return { observation, candidates: validCandidates, decisions, commitments, preferences, facts, errors };
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

function statementResolutionReason(resolution: ReturnType<typeof resolveStatement>): string {
  switch (resolution.action) {
    case 'link':
      return `Auto-linked to ${resolution.id} (score: ${resolution.score.totalScore.toFixed(2)})`;
    case 'confirm_link':
      return `Possibly linked to ${resolution.id} (score: ${resolution.score.totalScore.toFixed(2)}), needs confirmation`;
    case 'create_new':
      return 'No matching active statement found, creating new';
  }
}
