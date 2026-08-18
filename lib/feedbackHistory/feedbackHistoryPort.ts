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
 * exists somewhere else in the system — and event ids are derived from their
 * own fields rather than randomly generated, so an id an attacker can compute
 * must never be an authorisation boundary on its own.
 *
 * `failed` is the store declining a write on an event that does exist and is
 * not yet revoked. It is kept apart from the other three because reporting it
 * as `not_found` would tell the user their record is missing, and reporting it
 * as `revoked` would tell them a correction happened that did not.
 */
export type FeedbackRevokeOutcome = 'revoked' | 'already_revoked' | 'not_found' | 'failed';

/** One member per outcome, so narrowing on `outcome` also narrows `event`. */
export type FeedbackRevokeResult =
  | { readonly outcome: 'revoked'; readonly event: FeedbackEvent }
  | { readonly outcome: 'already_revoked'; readonly event: FeedbackEvent }
  | { readonly outcome: 'not_found'; readonly event: null }
  | { readonly outcome: 'failed'; readonly event: null };

/**
 * Named rather than positional on purpose. scopeId and eventId are both plain
 * strings, so a swap type-checks cleanly — and this call guards an
 * authorization boundary, where a silent swap turns the ownership check into a
 * lookup of a nonexistent id that "passes" by returning not_found.
 */
export interface FeedbackRevokeRequest {
  readonly scopeId: string;
  readonly eventId: string;
  readonly at: string;
}

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
  revokeForScope(request: FeedbackRevokeRequest): FeedbackRevokeResult;
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

    revokeForScope({ scopeId, eventId, at }: FeedbackRevokeRequest): FeedbackRevokeResult {
      // The ownership check happens here, before the store is asked to do
      // anything. `FeedbackEventStore.revoke(id, at)` takes no scope and will
      // revoke whatever id it is handed, so this is the only place isolation
      // can be enforced — and event ids are derived from their own contents,
      // so knowing an id proves nothing about who it belongs to.
      const existing = store.get(eventId);
      if (!existing || existing.scopeId !== scopeId) return { outcome: 'not_found', event: null };

      // `revoke()` answers false for "missing" and "already revoked" alike, so
      // the distinction is drawn here rather than inferred from its result.
      // Re-revoking is a benign no-op, not an error.
      if (existing.revokedAt) return { outcome: 'already_revoked', event: existing };

      const applied = store.revoke(eventId, at);
      const after = store.get(eventId);
      // A store that declines, or that claims success without stamping, must
      // not be reported to the user as a correction that took effect.
      if (!applied || !after?.revokedAt) return { outcome: 'failed', event: null };
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
