/**
 * Turns feedback events into the user-facing history surface.
 *
 * A row says what was observed at one moment. It carries no summary, no
 * inferred preference and no ranking, because the screen it feeds exists to
 * show the difference between "we saw you defer this on Tuesday" and "you are
 * someone who defers" — and a response that pre-chewed the events into a
 * characterisation would erase that difference before the UI ever saw it.
 */

import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type FeedbackEvent,
  type FeedbackHistoryResponse,
  type FeedbackHistoryRow,
} from '../../src/contracts/v1/feedbackContracts';
import type { FeedbackHistoryPort } from './feedbackHistoryPort';

/** Rows returned when the caller does not ask for a specific number. */
export const DEFAULT_HISTORY_LIMIT = 100;

/** Hard ceiling, so a caller cannot ask for an unbounded response. */
export const MAX_HISTORY_LIMIT = 500;

export function toHistoryRow(event: FeedbackEvent): FeedbackHistoryRow {
  return {
    id: event.id,
    outcome: event.outcome,
    subjectId: event.subjectId,
    occurredAt: event.occurredAt,
    revokedAt: event.revokedAt ?? null,
    // Already-revoked rows stay listed but stop offering the control: a second
    // revoke would only rewrite when the user corrected us.
    canRevoke: !event.revokedAt,
  };
}

/**
 * Newest behaviour first, by when it happened rather than when we stored it —
 * the same choice aggregation makes, so a late arrival appears where the user
 * would look for it. `recordedAt` and then `id` break ties, so the order is
 * total and the response never varies with the store's iteration order.
 */
function newestFirst(left: FeedbackEvent, right: FeedbackEvent): number {
  if (left.occurredAt !== right.occurredAt) return left.occurredAt < right.occurredAt ? 1 : -1;
  if (left.recordedAt !== right.recordedAt) return left.recordedAt < right.recordedAt ? 1 : -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Clamps a caller-supplied limit; anything unusable falls back to the default. */
export function resolveHistoryLimit(raw: string | null): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.floor(parsed), MAX_HISTORY_LIMIT);
}

export function buildHistoryResponse(
  port: FeedbackHistoryPort,
  scopeId: string,
  limit: number = DEFAULT_HISTORY_LIMIT,
): FeedbackHistoryResponse {
  const rows = [...port.listForScope(scopeId)]
    .sort(newestFirst)
    .slice(0, limit)
    .map(toHistoryRow);

  const baseline = port.readBaseline(scopeId);
  // Counters carry no timestamps, so they can never become rows. They are
  // announced separately rather than dropped, otherwise the screen would show
  // less history than the system actually holds.
  const hasCounters = baseline
    ? Object.values(baseline.counters).some((count) => count > 0)
    : false;

  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    rows,
    baselineNotice: baseline && hasCounters
      ? { counters: baseline.counters, lastUpdatedAt: baseline.lastUpdatedAt }
      : null,
  };
}
