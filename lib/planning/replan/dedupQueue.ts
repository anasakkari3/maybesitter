/**
 * Pure deduplicating replan queue (#523, slice 2).
 *
 * When an external event or watcher impact triggers a replan, multiple rapid
 * notifications for the same scope and date must not spawn duplicate planner solves.
 *
 * This module manages deduplicating, coalescing, and ordering of replan requests.
 * Pure logic only: no clock, no storage, no scheduling side-effects.
 */

import type { ReplanQueueEntry, ReplanRequest } from '../../../src/contracts/v1/replanContracts';
import { compareByCodePoint } from '../shared/compare';
import { toEpochMs } from '../shared/time';

function isPendingStatus(status: ReplanRequest['status']): boolean {
  return status === 'enqueued' || status === 'in_progress';
}

function mergeRequests(existing: ReplanRequest, incoming: ReplanRequest): ReplanRequest {
  const allCauses = Array.from(
    new Set([...existing.causeChangeIds, ...incoming.causeChangeIds]),
  ).sort(compareByCodePoint);

  const priority =
    existing.priority === 'immediate' || incoming.priority === 'immediate'
      ? 'immediate'
      : 'background';

  return Object.freeze({
    ...existing,
    causeChangeIds: Object.freeze(allCauses),
    priority,
    // Keep earlier enqueuedAt, or incoming if earlier
    enqueuedAt:
      toEpochMs(existing.enqueuedAt) <= toEpochMs(incoming.enqueuedAt)
        ? existing.enqueuedAt
        : incoming.enqueuedAt,
    baseGeneration: incoming.baseGeneration ?? existing.baseGeneration,
  });
}

export interface EnqueueResult {
  readonly queue: readonly ReplanQueueEntry[];
  readonly entry: ReplanQueueEntry;
  readonly deduped: boolean;
}

/**
 * Enqueue a replan request, coalescing with any existing pending request for the
 * same scope and plan date.
 */
export function enqueueReplanRequest(
  queue: readonly ReplanQueueEntry[],
  request: ReplanRequest,
): EnqueueResult {
  const existingIndex = queue.findIndex(
    (item) =>
      item.request.scopeId === request.scopeId &&
      item.request.date === request.date &&
      isPendingStatus(item.request.status),
  );

  if (existingIndex >= 0) {
    const existing = queue[existingIndex]!;
    const mergedRequest = mergeRequests(existing.request, request);
    const updatedEntry: ReplanQueueEntry = Object.freeze({
      request: mergedRequest,
      deduplicatedCount: existing.deduplicatedCount + 1,
    });

    const nextQueue = queue.slice();
    nextQueue[existingIndex] = updatedEntry;

    return {
      queue: Object.freeze(nextQueue),
      entry: updatedEntry,
      deduped: true,
    };
  }

  const newEntry: ReplanQueueEntry = Object.freeze({
    request: Object.freeze({
      ...request,
      causeChangeIds: Object.freeze(request.causeChangeIds.slice().sort(compareByCodePoint)),
    }),
    deduplicatedCount: 1,
  });

  return {
    queue: Object.freeze([...queue, newEntry]),
    entry: newEntry,
    deduped: false,
  };
}

export interface DequeueResult {
  readonly next: ReplanQueueEntry | null;
  readonly remaining: readonly ReplanQueueEntry[];
}

/**
 * Pick the highest priority and oldest enqueued request.
 */
export function dequeueNextReplanRequest(queue: readonly ReplanQueueEntry[]): DequeueResult {
  const eligibleIndices: number[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (queue[i]!.request.status === 'enqueued') {
      eligibleIndices.push(i);
    }
  }

  if (eligibleIndices.length === 0) {
    return { next: null, remaining: queue };
  }

  // Sort eligible by: priority (immediate first), then enqueuedAt ascending, then requestId
  eligibleIndices.sort((a, b) => {
    const reqA = queue[a]!.request;
    const reqB = queue[b]!.request;

    if (reqA.priority !== reqB.priority) {
      return reqA.priority === 'immediate' ? -1 : 1;
    }

    const timeDiff = toEpochMs(reqA.enqueuedAt) - toEpochMs(reqB.enqueuedAt);
    if (timeDiff !== 0) return timeDiff;

    return reqA.requestId.localeCompare(reqB.requestId);
  });

  const nextIndex = eligibleIndices[0]!;
  const next = queue[nextIndex]!;
  const remaining = queue.filter((_, i) => i !== nextIndex);

  return { next, remaining: Object.freeze(remaining) };
}
