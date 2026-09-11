/**
 * Analytics events, in the user's own tree (UC-1.0c, #142).
 *
 * ── What this replaced ───────────────────────────────────────────
 *
 * `let events: PrivacySafeAnalyticsEvent[] = []` — a module-level array. Every
 * Cloud Run instance had its own, so the activation and funnel report answered
 * from whichever instance happened to serve the request, and every event was
 * lost on the next deploy. The numbers were not wrong so much as meaningless:
 * nobody could tell a real activation rate from a recently-restarted one.
 *
 * Events now live at `users/{uid}/analyticsEvents/{id}`, so they are durable,
 * shared between instances, and — the point of putting them *in* the user's
 * tree rather than a global table — deleted with the account by one
 * `deleteTree`, with no separate purge to remember.
 *
 * ── Retention is a field, not a cron job ─────────────────────────
 *
 * Each document carries `expiresAt` 400 days out and Firestore's TTL deletes
 * it (`infra/firestore-ttl.sh`). It is written as a `Date` on purpose: a TTL
 * policy only applies to a timestamp field, and firebase-admin converts a Date
 * to one. The memory adapter's JSON round-trip turns it into an ISO string
 * instead, which is a difference with no consequence — nothing reads the field,
 * the server enforces it — but it is the reason a test sees a string here.
 *
 * ── Why the uid is derived and not passed ────────────────────────
 *
 * The issue sketched `appendAnalyticsEvent(uid, value)`. Deriving the uid from
 * `event.anonymousUserId` instead means the document cannot land under a
 * different user than the event claims: with two parameters, a caller could
 * pass one uid and an event naming another, and the tree would disagree with
 * its contents. On the mobile path `anonymousUserId` already *is* the
 * participant id (`pilotService.recommendationContext`).
 */
import type { PrivacySafeAnalyticsEvent } from '../../src/contracts/v1/analyticsEventContracts';
import { requireValidAnalyticsEvent } from './privacySafeEvents';
import {
  ANALYTICS_EVENTS,
  getStorage,
  sortableDocId,
  userCol,
  userIdForKey,
} from '../storage';

/** The retention the TTL policy enforces. */
export const ANALYTICS_RETENTION_DAYS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Breaks ties between events sharing a millisecond, so a listing reads back in
 * the order it was written. Process-local, and only ever a tiebreak:
 * `occurredAt` is what orders events across instances, and the report sorts by
 * it anyway. Without this, several events stamped with one request's `now`
 * would come back in document-id order, which is random.
 */
let sequence = 0;

/** `<occurredAt>_<sequence>_<eventId>`, so a plain listing is in write order. */
function eventDocId(event: PrivacySafeAnalyticsEvent, order: number): string {
  return sortableDocId(event.occurredAt, `${String(order).padStart(9, '0')}-${event.eventId}`);
}

/** The event plus the retention stamp Firestore's TTL reads and the order key. */
interface StoredAnalyticsEvent extends PrivacySafeAnalyticsEvent {
  expiresAt: Date;
  sequence: number;
}

function expiresAtFor(event: PrivacySafeAnalyticsEvent): Date {
  const occurred = Date.parse(event.occurredAt);
  const base = Number.isNaN(occurred) ? Date.now() : occurred;
  return new Date(base + ANALYTICS_RETENTION_DAYS * DAY_MS);
}

/**
 * `expiresAt` and `sequence` are storage bookkeeping, not part of the event.
 * They are stripped on the way out because `validateAnalyticsEvent` rejects
 * unknown top-level fields — returning them would make every stored event fail
 * its own contract.
 */
function toEvent(stored: StoredAnalyticsEvent): PrivacySafeAnalyticsEvent {
  const { expiresAt: _retention, sequence: _order, ...event } = stored;
  return event as PrivacySafeAnalyticsEvent;
}

/**
 * Oldest first, and ordered here rather than left to the backend.
 *
 * The two adapters disagree about the natural order of a collection-group
 * read: the memory adapter sorts by document id, Firestore by full document
 * path — which puts every one of user A's events before user B's regardless of
 * when they happened. Sorting explicitly means a caller sees the same sequence
 * from either, instead of a test passing on one backend and the report reading
 * differently in production.
 */
function byWriteOrder(a: StoredAnalyticsEvent, b: StoredAnalyticsEvent): number {
  const occurred = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (occurred !== 0 && !Number.isNaN(occurred)) return occurred;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function collectionFor(anonymousUserId: string): string {
  return userCol(userIdForKey(anonymousUserId), ANALYTICS_EVENTS);
}

/**
 * Validates and records one event.
 *
 * A `data_deleted` event purges that user's history *before* it is written, so
 * the receipt is the one document that survives — which is exactly what makes
 * the deletion auditable rather than merely silent.
 */
export async function appendAnalyticsEvent(value: unknown): Promise<PrivacySafeAnalyticsEvent> {
  const event = requireValidAnalyticsEvent(value);
  const storage = getStorage();
  const collection = collectionFor(event.anonymousUserId);

  if (event.eventName === 'data_deleted') {
    const existing = await storage.list<StoredAnalyticsEvent>(collection);
    for (const row of existing) await storage.delete(`${collection}/${row.id}`);
  }

  sequence += 1;
  const stored: StoredAnalyticsEvent = { ...event, expiresAt: expiresAtFor(event), sequence };
  await storage.set<StoredAnalyticsEvent>(`${collection}/${eventDocId(event, sequence)}`, stored);
  return event;
}

/**
 * Every user's events, for the activation and funnel report.
 *
 * A collection-group read rather than a loop over accounts: the report is a
 * cross-user view, and iterating users would cost one query per person.
 */
export async function getAnalyticsEvents(): Promise<PrivacySafeAnalyticsEvent[]> {
  const rows = await getStorage().listGroup<StoredAnalyticsEvent>(ANALYTICS_EVENTS);
  return rows.map((row) => row.data).sort(byWriteOrder).map(toEvent);
}

/** One user's events, oldest first. */
export async function getAnalyticsEventsFor(anonymousUserId: string): Promise<PrivacySafeAnalyticsEvent[]> {
  const rows = await getStorage().list<StoredAnalyticsEvent>(collectionFor(anonymousUserId));
  return rows.map((row) => row.data).sort(byWriteOrder).map(toEvent);
}

/**
 * Clears every recorded event.
 *
 * Deliberately not `resetStorageForTests()`: a test that installed its own
 * adapter with `setStorageForTests` needs that adapter to stay installed, or
 * the trust record and the analytics would end up in two different stores.
 * This empties the collection instead, which is the thing the caller meant.
 */
export async function resetAnalyticsEventsForTests(): Promise<void> {
  const storage = getStorage();
  const rows = await storage.listGroup<StoredAnalyticsEvent>(ANALYTICS_EVENTS);
  for (const row of rows) await storage.delete(row.path);
}
