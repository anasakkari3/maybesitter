import { createHash } from 'node:crypto';
import {
  USER_STATE_PROJECTION_CONTRACT_VERSION,
  USER_STATE_PROJECTION_SCHEMA_VERSION,
  type ProjectionSectionMeta,
  type UserStateProjection,
  type UserStateProjectionInput,
} from '../../src/contracts/v1/userStateProjectionContracts';

export interface UserStateCompositionInput extends UserStateProjectionInput {
  readonly availabilityUpdatedAt?: string | null;
  readonly relevantMemoryUpdatedAt?: string | null;
  readonly relevantMemorySummaryDigest?: string | null;
  readonly freshForMs?: number;
}

const DEFAULT_FRESH_FOR_MS = 36 * 60 * 60 * 1000;

function stableDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function freshness(updatedAt: string | null, now: string, freshForMs: number): ProjectionSectionMeta['freshness'] {
  if (!updatedAt) return 'missing';
  const updatedMs = Date.parse(updatedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) return 'stale';
  return nowMs - updatedMs <= freshForMs ? 'fresh' : 'stale';
}

function sectionMeta(
  source: ProjectionSectionMeta['source'],
  updatedAt: string | null,
  now: string,
  freshForMs: number,
  digestInput: unknown,
): ProjectionSectionMeta {
  return {
    source,
    freshness: freshness(updatedAt, now, freshForMs),
    updatedAt,
    inputDigest: updatedAt ? stableDigest(digestInput) : null,
  };
}

export function composeUserStateProjection(input: UserStateCompositionInput): UserStateProjection {
  const freshForMs = input.freshForMs ?? DEFAULT_FRESH_FOR_MS;
  const busy = [...(input.busy ?? [])];
  const free = [...(input.free ?? [])];
  const focus = [...(input.focus ?? [])];
  const memoryIds = Array.from(new Set(input.relevantMemoryIds ?? [])).sort();
  const deadlines = [...(input.deadlines ?? [])].sort((left, right) => {
    const due = left.dueAt.localeCompare(right.dueAt);
    return due === 0 ? left.deadlineId.localeCompare(right.deadlineId) : due;
  });
  const connectedContextSources = [...(input.connectedContextSources ?? [])].sort((left, right) => (
    left.connectionId.localeCompare(right.connectionId)
  ));
  const availabilityUpdatedAt = input.availabilityUpdatedAt ?? null;
  const relevantMemoryUpdatedAt = input.relevantMemoryUpdatedAt ?? null;

  return {
    version: USER_STATE_PROJECTION_CONTRACT_VERSION,
    schemaVersion: USER_STATE_PROJECTION_SCHEMA_VERSION,
    scopeId: input.scopeId,
    computedAt: input.now,
    readiness: input.readiness ?? null,
    current: {
      meta: sectionMeta(
        'availability',
        availabilityUpdatedAt,
        input.now,
        freshForMs,
        { busy, free, focus },
      ),
      busy,
      free,
      focus,
    },
    relevantMemory: {
      meta: sectionMeta(
        'memory',
        relevantMemoryUpdatedAt,
        input.now,
        freshForMs,
        { memoryIds, summaryDigest: input.relevantMemorySummaryDigest ?? null },
      ),
      memoryIds,
      summaryDigest: input.relevantMemorySummaryDigest ?? null,
    },
    deadlines,
    plan: input.plan ?? {
      meta: {
        source: 'plan',
        freshness: 'missing',
        updatedAt: null,
        inputDigest: null,
      },
      status: 'none',
      planId: null,
      updatedAt: null,
    },
    connectedContextSources,
  };
}
