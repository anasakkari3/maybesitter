export type MemoryKind =
  | 'observation'
  | 'commitment'
  | 'fact'
  | 'preference'
  | 'hypothesis';

export type EnabledMemoryKind = 'observation' | 'commitment';

export type DetectedLanguage = 'ar' | 'he' | 'en' | 'mixed';

export type ObservationStatus = 'active' | 'superseded' | 'rejected';

export interface Observation {
  id: string;
  userId: string;
  sourceText: string;
  sourceMessageId: string;
  sourceConversationId?: string;
  observedAt: string;
  createdAt: string;
  language: DetectedLanguage;
  extractionVersion: string;
  status: ObservationStatus;
}

export type CommitmentMemoryStatus =
  | 'mentioned'
  | 'proposed'
  | 'confirmed'
  | 'scheduled'
  | 'completed'
  | 'cancelled'
  | 'postponed'
  | 'expired';

export type TimePrecision = 'none' | 'day' | 'approximate_time' | 'exact_time';

export interface CommitmentMemory {
  id: string;
  userId: string;
  title: string;
  description?: string;
  status: CommitmentMemoryStatus;
  dueAt?: string;
  timePrecision: TimePrecision;
  participants: string[];
  location?: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  evidenceIds: string[];
  supersedesCommitmentId?: string;
  requiresConfirmation: boolean;
  notificationEligible: boolean;
}

export type CandidateModality =
  | 'certain'
  | 'intended'
  | 'possible'
  | 'conditional'
  | 'negated'
  | 'reported';

export type CandidatePrecision = 'none' | 'day' | 'approximate' | 'exact';

export interface TemporalInfo {
  rawText: string;
  resolvedAt?: string;
  precision: CandidatePrecision;
}

export interface EvidenceSpan {
  start: number;
  end: number;
  text: string;
}

export interface MemoryCandidate {
  candidateType: EnabledMemoryKind | 'fact' | 'preference' | 'hypothesis' | 'none';
  normalizedText: string;
  modality: CandidateModality;
  confidence: number;
  temporal?: TemporalInfo;
  evidenceSpan: EvidenceSpan;
}

export type CommitmentEventType =
  | 'created'
  | 'confirmed'
  | 'scheduled'
  | 'rescheduled'
  | 'postponed'
  | 'completed'
  | 'cancelled'
  | 'corrected'
  | 'notification_enabled'
  | 'notification_disabled';

export interface CommitmentEvent {
  id: string;
  commitmentId: string;
  type: CommitmentEventType;
  fromStatus?: CommitmentMemoryStatus;
  toStatus?: CommitmentMemoryStatus;
  observationId?: string;
  reason: string;
  actor: 'user' | 'system' | 'model';
  modelConfidence?: number;
  createdAt: string;
}

export type NotificationReasonCode =
  | 'STATUS_NOT_CONFIRMED'
  | 'MISSING_TIME'
  | 'LOW_CONFIDENCE'
  | 'USER_CONFIRMATION_REQUIRED'
  | 'CONFLICTING_EVIDENCE'
  | 'ELIGIBLE';

export interface NotificationDecision {
  eligible: boolean;
  reasonCodes: NotificationReasonCode[];
  scheduledAt?: string;
}

export interface CommitmentMatchScore {
  commitmentId: string;
  participantScore: number;
  actionScore: number;
  temporalScore: number;
  semanticScore: number;
  totalScore: number;
  matchReasons: string[];
}
