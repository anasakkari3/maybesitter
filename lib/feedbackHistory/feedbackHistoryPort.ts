/**
 * The seam between the user-facing history/revoke API (#15) and the feedback
 * event store (#13).
 *
 * The API needs three things and nothing else: the events for one scope, the
 * pre-event-log baseline for that scope, and a revocation that can only touch
 * an event the caller actually owns. Naming that surface explicitly keeps the
 * transparency screen from depending on the store's whole write API, and keeps
 * the store free to change shape underneath it.
 *
 * Everything here is expressed in terms of the committed contract in
 * `src/contracts/v1/feedbackContracts.ts`. This module imports no store.
 *
 * ── Wiring (merge time) ────────────────────────────────────────────
 *
 *   import { createFeedbackEventStore } from '../feedback/feedbackEventStore';
 *   import {
 *     createFeedbackHistoryPort,
 *     setFeedbackHistoryPort,
 *   } from '../feedbackHistory/feedbackHistoryPort';
 *
 *   setFeedbackHistoryPort(createFeedbackHistoryPort(createFeedbackEventStore()));
 *
 * Until that call happens, both routes answer 503 `feedback_history_unavailable`.
 * That is deliberate: a transparency screen that silently renders an empty list
 * because nothing is wired behind it would be the exact failure this issue
 * exists to prevent.
 */

import type {
  FeedbackBaseline,
  FeedbackEvent,
  FeedbackEventStore,
} from '../../src/contracts/v1/feedbackContracts';

/**
 * `not_found` covers "no such event" and "belongs to another scope" alike.
 * Distinguishing them would turn revoke into an oracle for whether an id
 * exists somewhere else in the system.
 */
export type FeedbackRevokeOutcome = 'revoked' | 'already_revoked' | 'not_found';

export type FeedbackRevokeResult =
  | { readonly outcome: 'revoked' | 'already_revoked'; readonly event: FeedbackEvent }
  | { readonly outcome: 'not_found'; readonly event: null };

export interface FeedbackHistoryPort {
  /**
   * Every event in the scope, revoked ones included. History must show the
   * corrections a user made, not quietly drop them: a screen that hid revoked
   * rows would make the correction unverifiable.
   *
   * Ordering is not part of this contract — the route imposes its own total
   * order so the response never depends on a store's iteration order.
   */
  listForScope(scopeId: string): readonly FeedbackEvent[];

  /** The scope's pre-event-log counters, or null when it has no history. */
  readBaseline(scopeId: string): FeedbackBaseline | null;

  /**
   * Stamps the revocation on one event, and only if that event belongs to
   * `scopeId`. Re-revoking returns the event unchanged: the correction keeps
   * the timestamp it originally had.
   */
  revokeForScope(scopeId: string, eventId: string, at: string): FeedbackRevokeResult;
}

/**
 * Adapts a `FeedbackEventStore` to the port, adding the one guarantee the
 * store's own `revoke(id, at)` cannot make on its own: that the caller owns
 * the event. The scope check lives here rather than in the route so no future
 * caller of the port can forget it.
 */
export function createFeedbackHistoryPort(store: FeedbackEventStore): FeedbackHistoryPort {
  return {
    listForScope(scopeId: string): readonly FeedbackEvent[] {
      return store.list({ scopeId, includeRevoked: true, newestFirst: true });
    },

    readBaseline(scopeId: string): FeedbackBaseline | null {
      return store.readBaseline(scopeId);
    },

    revokeForScope(scopeId: string, eventId: string, at: string): FeedbackRevokeResult {
      const existing = store.get(eventId);
      if (!existing || existing.scopeId !== scopeId) return { outcome: 'not_found', event: null };
      if (existing.revokedAt) return { outcome: 'already_revoked', event: existing };

      const applied = store.revoke(eventId, at);
      // A store that declines the write must not be reported as a success.
      const after = store.get(eventId);
      if (!applied || !after?.revokedAt) {
        return after && after.scopeId === scopeId && after.revokedAt
          ? { outcome: 'already_revoked', event: after }
          : { outcome: 'not_found', event: null };
      }
      return { outcome: 'revoked', event: after };
    },
  };
}

/* ── Injection seam ───────────────────────────────────────────────── */

let installed: FeedbackHistoryPort | null = null;

/** Installs the port the routes read. Pass null to clear it (tests). */
export function setFeedbackHistoryPort(port: FeedbackHistoryPort | null): void {
  installed = port;
}

/** The installed port, or null when nothing has been wired yet. */
export function getFeedbackHistoryPort(): FeedbackHistoryPort | null {
  return installed;
}
