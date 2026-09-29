import type { BusyBlock } from '../calendar/busyBlocks';
import { canonicalJson, sha256Hex } from '../evaluation/registry/fingerprint';
import { compareByCodePoint } from '../planning/shared/compare';
import type { RuntimeMemoryRecord } from '../../src/contracts/v1/memoryContracts';
import type { Commitment } from '../../src/domain/stateMachine';
import { CONTEXT_ENRICHMENT_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts';
import {
  USER_CONTEXT_LIMITS,
  USER_CONTEXT_SCHEMA_VERSION,
  USER_CONTEXT_SOURCES,
  type ScopedContextBatch,
  type UserContextBusyItem,
  type UserContextCommitmentItem,
  type UserContextConsentProof,
  type UserContextExternalReference,
  type UserContextFreshness,
  type UserContextGoalItem,
  type UserContextMemoryItem,
  type UserContextModelPayload,
  type UserContextProvenance,
  type UserContextPurpose,
  type UserContextSection,
  type UserContextSnapshot,
  type UserContextSource,
  type UserContextTrust,
} from '../../src/contracts/v1/userContextContracts';

export interface ExternalContextReferenceInput {
  readonly sourceId: string;
  readonly source: 'gmail' | 'drive' | 'share';
  readonly sourceDigest: string;
  readonly observedAt: string;
  readonly validThrough: string;
}

export interface BuildUserContextSnapshotInput {
  readonly scopeId: string;
  readonly purpose: UserContextPurpose;
  readonly computedAt: string;
  readonly timezone: string;
  readonly window: Readonly<{ startAt: string; endAt: string }>;
  readonly consent: UserContextConsentProof;
  readonly memories: ScopedContextBatch<RuntimeMemoryRecord> | null;
  readonly commitments: ScopedContextBatch<Commitment> | null;
  readonly busyBlocks: ScopedContextBatch<BusyBlock> | null;
  readonly externalReferences: ScopedContextBatch<ExternalContextReferenceInput> | null;
}

const TERMINAL_COMMITMENT_STATUSES = new Set(['completed', 'dropped', 'archived']);
const RECOMMENDATION_INELIGIBLE_STATUSES = new Set([
  'draft',
  'needs_clarification',
  'pending_confirmation',
]);
const MEMORY_SOURCE_ORDER = Object.freeze({
  user_stated: 0,
  deterministic_rule: 1,
  model_inferred: 2,
});
const PRIORITY_ORDER = Object.freeze({ high: 0, normal: 1, low: 2 });

function epoch(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be an ISO-8601 instant`);
  return parsed;
}

function assertScope<T>(scopeId: string, batch: ScopedContextBatch<T> | null, name: string): void {
  if (batch !== null && batch.scopeId !== scopeId) {
    throw new Error(`${name} scope does not match requested scope`);
  }
}

function assertConsent(consent: UserContextConsentProof): ReadonlySet<UserContextSource> {
  if (consent?.state !== 'granted' || consent.version !== CONTEXT_ENRICHMENT_CONSENT_VERSION) {
    throw new Error('context enrichment requires the current granted consent');
  }

  const known = new Set<string>(USER_CONTEXT_SOURCES);
  const allowed = new Set<UserContextSource>();
  for (const source of consent.allowedSources ?? []) {
    if (!known.has(source)) throw new Error(`unknown context source: ${String(source)}`);
    allowed.add(source);
  }
  return allowed;
}

function requireAllowed(allowed: ReadonlySet<UserContextSource>, source: UserContextSource): void {
  if (!allowed.has(source)) throw new Error(`context source is not consented: ${source}`);
}

function contextRef(input: {
  scopeId: string;
  source: UserContextSource;
  sourceId: string;
  computedAt: string;
}): `ctx_${string}` {
  return `ctx_${sha256Hex(canonicalJson({
    version: 'context-ref-v1',
    scopeId: input.scopeId,
    source: input.source,
    sourceId: input.sourceId,
    computedAt: input.computedAt,
  })).slice(0, 32)}`;
}

function provenance(input: {
  scopeId: string;
  source: UserContextSource;
  sourceId: string;
  computedAt: string;
  trust: UserContextTrust;
  observedAt: string;
  validThrough: string | null;
}): UserContextProvenance {
  return {
    ref: contextRef(input),
    source: input.source,
    trust: input.trust,
    observedAt: input.observedAt,
    validThrough: input.validThrough,
  };
}

function freshness<T>(batch: ScopedContextBatch<T> | null, computedAtMs: number): UserContextFreshness {
  if (batch === null) return 'missing';
  if (batch.validThrough !== null && epoch(batch.validThrough, 'batch.validThrough') <= computedAtMs) return 'stale';
  return 'fresh';
}

function section<T>(
  batch: ScopedContextBatch<unknown> | null,
  computedAtMs: number,
  eligibleCount: number,
  items: readonly T[],
): UserContextSection<T> {
  const state = freshness(batch, computedAtMs);
  const safeItems = state === 'fresh' ? items : [];
  const digestInput = { freshness: state, items: safeItems };
  return {
    metadata: {
      freshness: state,
      updatedAt: batch?.updatedAt ?? null,
      validThrough: batch?.validThrough ?? null,
      sectionDigest: sha256Hex(canonicalJson(digestInput)),
      selected: safeItems.length,
      omittedByLimit: state === 'fresh' ? Math.max(0, eligibleCount - safeItems.length) : 0,
    },
    items: safeItems,
  };
}

function dedupeById<T>(items: readonly T[], idOf: (item: T) => string): readonly T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = idOf(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function truncateCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('');
}

function memoryOrder(left: RuntimeMemoryRecord, right: RuntimeMemoryRecord): number {
  const source = MEMORY_SOURCE_ORDER[left.source] - MEMORY_SOURCE_ORDER[right.source];
  if (source !== 0) return source;
  if (left.confidence !== right.confidence) return right.confidence - left.confidence;
  const observed = epoch(right.observedAt, 'memory.observedAt') - epoch(left.observedAt, 'memory.observedAt');
  if (observed !== 0) return observed;
  const id = compareByCodePoint(left.id, right.id);
  return id !== 0 ? id : compareByCodePoint(canonicalJson(left), canonicalJson(right));
}

function memoryEligible(record: RuntimeMemoryRecord, scopeId: string, computedAtMs: number): boolean {
  if (record.scopeId !== scopeId) throw new Error('memory record scope does not match requested scope');
  if (record.status !== 'active' || epoch(record.staleAfter, 'memory.staleAfter') <= computedAtMs) return false;
  if (record.source === 'model_inferred' && !record.provenance?.confirmedByUserAt) return false;
  return true;
}

function commitmentOrder(left: Commitment, right: Commitment): number {
  if (left.timeSpec.dueAt === null && right.timeSpec.dueAt !== null) return 1;
  if (left.timeSpec.dueAt !== null && right.timeSpec.dueAt === null) return -1;
  if (left.timeSpec.dueAt !== null && right.timeSpec.dueAt !== null) {
    const due = epoch(left.timeSpec.dueAt, 'commitment.dueAt') - epoch(right.timeSpec.dueAt, 'commitment.dueAt');
    if (due !== 0) return due;
  }
  const priority = PRIORITY_ORDER[left.priority.level] - PRIORITY_ORDER[right.priority.level];
  if (priority !== 0) return priority;
  const updated = epoch(right.updatedAt, 'commitment.updatedAt') - epoch(left.updatedAt, 'commitment.updatedAt');
  if (updated !== 0) return updated;
  const id = compareByCodePoint(left.id, right.id);
  return id !== 0 ? id : compareByCodePoint(canonicalJson(left), canonicalJson(right));
}

function commitmentEligible(commitment: Commitment, purpose: UserContextPurpose): boolean {
  if (TERMINAL_COMMITMENT_STATUSES.has(commitment.status)) return false;
  if (purpose === 'recommendation') {
    return commitment.confirmedAt !== null && !RECOMMENDATION_INELIGIBLE_STATUSES.has(commitment.status);
  }
  return true;
}

function trustForMemory(record: RuntimeMemoryRecord): UserContextTrust {
  return record.source === 'user_stated' || record.provenance?.confirmedByUserAt
    ? 'user_confirmed'
    : 'canonical';
}

export function buildUserContextSnapshot(input: BuildUserContextSnapshotInput): UserContextSnapshot {
  const computedAtMs = epoch(input.computedAt, 'computedAt');
  const windowStartMs = epoch(input.window.startAt, 'window.startAt');
  const windowEndMs = epoch(input.window.endAt, 'window.endAt');
  if (windowStartMs >= windowEndMs) throw new Error('context window must have positive duration');
  if (!input.scopeId.trim()) throw new Error('scopeId is required');
  if (!input.timezone.trim()) throw new Error('timezone is required');
  epoch(input.consent.changedAt, 'consent.changedAt');

  assertScope(input.scopeId, input.memories, 'memories');
  assertScope(input.scopeId, input.commitments, 'commitments');
  assertScope(input.scopeId, input.busyBlocks, 'busy context');
  assertScope(input.scopeId, input.externalReferences, 'externalReferences');
  const allowed = assertConsent(input.consent);

  const eligibleMemoryRecords = input.memories === null
    ? []
    : dedupeById(
        input.memories.items.filter((record) => memoryEligible(record, input.scopeId, computedAtMs)).slice().sort(memoryOrder),
        (record) => record.id,
      );
  const memoryRecords = eligibleMemoryRecords.filter((record) => record.kind !== 'goal');
  const goalRecords = eligibleMemoryRecords.filter((record) => record.kind === 'goal');
  if (memoryRecords.length > 0) requireAllowed(allowed, 'memory');
  if (goalRecords.length > 0) requireAllowed(allowed, 'goal');

  const memoryItems: readonly UserContextMemoryItem[] = memoryRecords
    .slice(0, USER_CONTEXT_LIMITS.memories)
    .map((record) => ({
      content: truncateCodePoints(record.content, USER_CONTEXT_LIMITS.memoryCodePoints),
      kind: record.kind as UserContextMemoryItem['kind'],
      language: record.language,
      confidence: record.confidence,
      provenance: provenance({
        scopeId: input.scopeId,
        source: 'memory',
        sourceId: record.id,
        computedAt: input.computedAt,
        trust: trustForMemory(record),
        observedAt: record.observedAt,
        validThrough: record.staleAfter,
      }),
    }));
  const goalItems: readonly UserContextGoalItem[] = goalRecords
    .slice(0, USER_CONTEXT_LIMITS.goals)
    .map((record) => ({
      content: truncateCodePoints(record.content, USER_CONTEXT_LIMITS.memoryCodePoints),
      language: record.language,
      confidence: record.confidence,
      provenance: provenance({
        scopeId: input.scopeId,
        source: 'goal',
        sourceId: record.id,
        computedAt: input.computedAt,
        trust: trustForMemory(record),
        observedAt: record.observedAt,
        validThrough: record.staleAfter,
      }),
    }));

  const eligibleCommitments = input.commitments === null
    ? []
    : dedupeById(
        input.commitments.items.filter((item) => commitmentEligible(item, input.purpose)).slice().sort(commitmentOrder),
        (item) => item.id,
      );
  if (eligibleCommitments.length > 0) requireAllowed(allowed, 'commitment');
  const commitmentItems: readonly UserContextCommitmentItem[] = eligibleCommitments
    .slice(0, USER_CONTEXT_LIMITS.commitments)
    .map((item) => ({
      kind: item.kind,
      title: truncateCodePoints(item.title, USER_CONTEXT_LIMITS.commitmentTitleCodePoints),
      status: item.status as UserContextCommitmentItem['status'],
      priority: item.priority.level,
      category: item.category,
      timeKind: item.timeSpec.kind,
      dueAt: item.timeSpec.dueAt,
      endAt: item.timeSpec.endAt,
      allDay: item.timeSpec.allDay,
      updatedAt: item.updatedAt,
      provenance: provenance({
        scopeId: input.scopeId,
        source: 'commitment',
        sourceId: item.id,
        computedAt: input.computedAt,
        trust: item.confirmedAt === null ? 'canonical' : 'user_confirmed',
        observedAt: item.updatedAt,
        validThrough: null,
      }),
    }));

  const eligibleBusy = input.busyBlocks === null
    ? []
    : dedupeById(
        input.busyBlocks.items
          .filter((item) => {
            const startAt = epoch(item.startAt, 'busy.startAt');
            const endAt = epoch(item.endAt, 'busy.endAt');
            if (startAt >= endAt) throw new Error('busy interval must have positive duration');
            return startAt < windowEndMs && endAt > windowStartMs;
          })
          .slice()
          .sort((left, right) => {
            const start = epoch(left.startAt, 'busy.startAt') - epoch(right.startAt, 'busy.startAt');
            if (start !== 0) return start;
            const end = epoch(left.endAt, 'busy.endAt') - epoch(right.endAt, 'busy.endAt');
            if (end !== 0) return end;
            const id = compareByCodePoint(left.blockId, right.blockId);
            return id !== 0 ? id : compareByCodePoint(canonicalJson(left), canonicalJson(right));
          }),
        (item) => `${item.sourceId}\u0000${item.blockId}`,
      );
  if (eligibleBusy.length > 0) requireAllowed(allowed, 'calendar_busy');
  const busyItems: readonly UserContextBusyItem[] = eligibleBusy
    .slice(0, USER_CONTEXT_LIMITS.busyBlocks)
    .map((item) => ({
      startAt: item.startAt,
      endAt: item.endAt,
      allDay: item.allDay,
      sourceKind: item.sourceKind,
      provenance: provenance({
        scopeId: input.scopeId,
        source: 'calendar_busy',
        sourceId: `${item.sourceId}\u0000${item.blockId}`,
        computedAt: input.computedAt,
        trust: 'canonical',
        observedAt: input.busyBlocks?.updatedAt ?? input.computedAt,
        validThrough: item.endAt,
      }),
    }));

  const eligibleExternal = input.externalReferences === null
    ? []
    : dedupeById(
        input.externalReferences.items
          .filter((item) => epoch(item.validThrough, 'external.validThrough') > computedAtMs)
          .slice()
          .sort((left, right) => {
            const observed = epoch(right.observedAt, 'external.observedAt') - epoch(left.observedAt, 'external.observedAt');
            if (observed !== 0) return observed;
            const source = compareByCodePoint(left.source, right.source);
            if (source !== 0) return source;
            const digest = compareByCodePoint(left.sourceDigest, right.sourceDigest);
            return digest !== 0 ? digest : compareByCodePoint(canonicalJson(left), canonicalJson(right));
          }),
        (item) => `${item.source}\u0000${item.sourceId}`,
      );
  for (const item of eligibleExternal) {
    if (!/^[a-f0-9]{64}$/i.test(item.sourceDigest)) {
      throw new Error('external sourceDigest must be a SHA-256 hex digest');
    }
  }
  for (const item of eligibleExternal) requireAllowed(allowed, item.source);
  const externalItems: readonly UserContextExternalReference[] = eligibleExternal
    .slice(0, USER_CONTEXT_LIMITS.externalReferences)
    .map((item) => ({
      source: item.source,
      sourceDigest: sha256Hex(canonicalJson({
        version: 'external-source-digest-v1',
        scopeId: input.scopeId,
        source: item.source,
        inputDigest: item.sourceDigest,
        computedAt: input.computedAt,
      })),
      provenance: provenance({
        scopeId: input.scopeId,
        source: item.source,
        sourceId: item.sourceId,
        computedAt: input.computedAt,
        trust: 'untrusted_external',
        observedAt: item.observedAt,
        validThrough: item.validThrough,
      }),
    }));

  const withoutDigest: Omit<UserContextSnapshot, 'snapshotDigest'> = {
    schemaVersion: USER_CONTEXT_SCHEMA_VERSION,
    scopeId: input.scopeId,
    purpose: input.purpose,
    computedAt: input.computedAt,
    timezone: input.timezone,
    window: { ...input.window },
    consent: {
      ...input.consent,
      allowedSources: Array.from(new Set(input.consent.allowedSources)).sort(compareByCodePoint),
    },
    memory: section(input.memories, computedAtMs, memoryRecords.length, memoryItems),
    goals: section(input.memories, computedAtMs, goalRecords.length, goalItems),
    commitments: section(input.commitments, computedAtMs, eligibleCommitments.length, commitmentItems),
    busy: section(input.busyBlocks, computedAtMs, eligibleBusy.length, busyItems),
    external: section(input.externalReferences, computedAtMs, eligibleExternal.length, externalItems),
  };

  return {
    ...withoutDigest,
    snapshotDigest: sha256Hex(canonicalJson(withoutDigest)),
  };
}

export function toUserContextModelPayload(snapshot: UserContextSnapshot): UserContextModelPayload {
  const { scopeId: _scopeId, consent: _consent, ...payload } = snapshot;
  return payload;
}
