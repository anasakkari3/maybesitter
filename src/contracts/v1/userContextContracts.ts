import { CONTEXT_ENRICHMENT_CONSENT_VERSION } from './consentContracts';

export const USER_CONTEXT_SCHEMA_VERSION = 'user-context-v1' as const;

export const USER_CONTEXT_LIMITS = Object.freeze({
  memories: 12,
  goals: 8,
  commitments: 16,
  busyBlocks: 48,
  externalReferences: 20,
  memoryCodePoints: 200,
  commitmentTitleCodePoints: 120,
  maxTextCodePoints: 6000,
});

export const USER_CONTEXT_SOURCES = [
  'memory',
  'goal',
  'commitment',
  'calendar_busy',
  'gmail',
  'drive',
  'share',
] as const;

export type UserContextSource = (typeof USER_CONTEXT_SOURCES)[number];
export type UserContextPurpose = 'capture' | 'recommendation';
export type UserContextFreshness = 'fresh' | 'stale' | 'missing';
export type UserContextTrust = 'user_confirmed' | 'canonical' | 'untrusted_external';

export interface UserContextConsentProof {
  readonly state: 'granted';
  readonly version: typeof CONTEXT_ENRICHMENT_CONSENT_VERSION;
  readonly changedAt: string;
  readonly allowedSources: readonly UserContextSource[];
}

/** `null` at the call site means the source was unavailable or not queried. */
export interface ScopedContextBatch<T> {
  readonly scopeId: string;
  readonly updatedAt: string | null;
  readonly validThrough: string | null;
  readonly items: readonly T[];
}

export interface UserContextProvenance {
  /** Request-scoped opaque reference. Never a raw database/provider id. */
  readonly ref: `ctx_${string}`;
  readonly source: UserContextSource;
  readonly trust: UserContextTrust;
  readonly observedAt: string;
  readonly validThrough: string | null;
}

export interface UserContextSectionMetadata {
  readonly freshness: UserContextFreshness;
  readonly updatedAt: string | null;
  readonly validThrough: string | null;
  readonly sectionDigest: string;
  readonly selected: number;
  readonly omittedByLimit: number;
}

export interface UserContextMemoryItem {
  readonly content: string;
  readonly kind: 'fact' | 'preference' | 'hypothesis';
  readonly language: 'ar' | 'he' | 'en' | 'mixed';
  readonly confidence: number;
  readonly provenance: UserContextProvenance;
}

export interface UserContextGoalItem {
  readonly content: string;
  readonly language: 'ar' | 'he' | 'en' | 'mixed';
  readonly confidence: number;
  readonly provenance: UserContextProvenance;
}

export interface UserContextCommitmentItem {
  readonly kind: 'task' | 'follow_up';
  readonly title: string;
  readonly status: 'draft' | 'needs_clarification' | 'pending_confirmation' | 'active' | 'deferred' | 'missed';
  readonly priority: 'low' | 'normal' | 'high';
  readonly category: 'work' | 'family' | 'health' | 'finance' | 'social' | 'errands' | null;
  readonly timeKind: 'unscheduled' | 'due_by' | 'scheduled_event';
  readonly dueAt: string | null;
  readonly endAt: string | null;
  readonly allDay: boolean;
  readonly updatedAt: string;
  readonly provenance: UserContextProvenance;
}

export interface UserContextBusyItem {
  readonly startAt: string;
  readonly endAt: string;
  readonly allDay: boolean;
  readonly sourceKind: 'device' | 'google' | 'ics' | 'manual' | 'weekly';
  readonly provenance: UserContextProvenance;
}

export interface UserContextExternalReference {
  readonly source: 'gmail' | 'drive' | 'share';
  /** Digest of the request-scoped source, never its provider id or content. */
  readonly sourceDigest: string;
  readonly provenance: UserContextProvenance;
}

export interface UserContextSection<T> {
  readonly metadata: UserContextSectionMetadata;
  readonly items: readonly T[];
}

export interface UserContextSnapshot {
  readonly schemaVersion: typeof USER_CONTEXT_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly purpose: UserContextPurpose;
  readonly computedAt: string;
  readonly timezone: string;
  readonly window: Readonly<{ startAt: string; endAt: string }>;
  readonly consent: UserContextConsentProof;
  readonly memory: UserContextSection<UserContextMemoryItem>;
  readonly goals: UserContextSection<UserContextGoalItem>;
  readonly commitments: UserContextSection<UserContextCommitmentItem>;
  readonly busy: UserContextSection<UserContextBusyItem>;
  readonly external: UserContextSection<UserContextExternalReference>;
  readonly snapshotDigest: string;
}

/** The only shape intended to cross the Vertex boundary. */
export type UserContextModelPayload = Omit<UserContextSnapshot, 'scopeId' | 'consent'>;
