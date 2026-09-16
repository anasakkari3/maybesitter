/**
 * Subscribing to an external calendar by URL (UC-3.4, #188).
 *
 * A student pastes their Moodle "Export calendar" link once. The server fetches
 * it through `safeFetch`, reads it with `classifyIcs`, turns its lectures into
 * busy time through #186's `replaceBusyBlocks`, and turns its deadlines into
 * **proposals** the student accepts or dismisses. Every six hours it does it
 * again.
 *
 * ── The URL is a password ────────────────────────────────────────
 *
 * A Moodle export URL carries `authtoken=`: anyone holding it reads that
 * student's calendar. So it is stored only as a `fieldEncryption` blob bound
 * to `fieldPurpose('ics-url', feedId)` — per feed, so two feeds' blobs cannot
 * be swapped — and it is never logged, never returned and never put in an
 * error. A log line names a feed id and `hostHashOf(host)` and nothing else.
 *
 * A decryption failure never clears the stored blob (the rule #381 set down):
 * `kms_unavailable` is an outage and is retried soon without counting as a
 * failure; `decrypt_failed` counts as one, and after five the feed shows an
 * error the user can resolve by removing it — the server never decides that
 * for them.
 *
 * ── A deadline is a proposal ─────────────────────────────────────
 *
 * The feed is somebody else's text. Nothing it contains becomes a commitment
 * unless the user accepts it, or turned on auto-accept *for that feed*; and a
 * feed can do nothing else at all — no model reads it, and the only effect of a
 * refresh is rows in the two collections this module owns and busy blocks under
 * this feed's own source id.
 *
 * Proposals are rows in `icsFeedItems` rather than capture proposals. A capture
 * proposal is confirmable for thirty minutes (`CAPTURE_PROPOSAL_TTL_MS`) and
 * swept after a day, because "tomorrow at 9" goes stale; a deadline the feed
 * published for next month does not, and has to still be there when the user
 * opens the app on Thursday.
 *
 * ── One row per occurrence, and what a refresh does to it ────────
 *
 * The key is `sha256([feedId, UID, RECURRENCE-ID])`, so seeing an item again
 * finds its row. Then:
 *
 * - a lower SEQUENCE than the row's is stale and ignored;
 * - an unchanged due time and title is no change, whatever DTSTAMP says
 *   (Google restamps every export);
 * - a changed one updates a **pending** row in place, puts a "moved" notice
 *   with the new time on an **accepted** one (the commitment is not touched
 *   until the user says so), brings a **rejected** one back exactly once, and
 *   revives a **withdrawn** one;
 * - an item that should still be in the feed's window and is not: a pending row
 *   is withdrawn, an accepted one gets a "removed from source" notice, and the
 *   commitment stays.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Command } from '../../src/domain/stateMachine';
import { applyParticipantCommand, commitCommandsWithClaim } from '../services/mobile/participantState';
import { DEFAULT_MOBILE_TIMEZONE } from '../services/mobile/time';
import {
  decryptField,
  encryptField,
  fieldPurpose,
  FieldEncryptionError,
  type EncryptedField,
  type FieldEncryptionOptions,
} from '../security/fieldEncryption';
import { getStorage, type StorageAdapter } from '../storage';
import { ICS_FEED_ITEMS, ICS_FEEDS, USERS, requireUserId, userCol, userDoc, userSubDoc } from '../storage/paths';
import { newUserDocument, type UserDocument } from '../storage/userDocument';
import { hostHashOf, normalizeFeedUrl, safeFetch, SafeFetchError, type SafeFetchOptions, type SafeFetchResult } from '../net/safeFetch';
import { busyBlockId, deleteBusySource, listBusyBlocks, replaceBusyBlocks, type BusyBlock } from './busyBlocks';
import {
  BUSY_WINDOW_DAYS,
  classifyIcs,
  cleanTitle,
  DEADLINE_WINDOW_DAYS,
  IcsParseError,
  MAX_DEADLINES,
  type DeadlineCandidate,
  type IcsClassification,
} from './icsImport';

export const MAX_FEEDS_PER_USER = 5;
export const MAX_LABEL_LENGTH = 60;
export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MAX_BACKOFF_MS = 48 * 60 * 60 * 1000;
export const FAILURES_BEFORE_ERROR = 5;
export const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
/** A KMS outage is not the feed's fault: try again soon, without counting it. */
export const KMS_RETRY_MS = 30 * 60 * 1000;
/**
 * How long a 304 is trusted. The busy window moves every day while the feed
 * does not change, so a conditional fetch that kept answering 304 would keep
 * the lectures that have since entered the window out of it. Past this age the
 * next fetch is unconditional.
 */
export const CONDITIONAL_FETCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Decided rows whose due time is this far behind are pruned, so the collection stays bounded. */
export const ITEM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_TICK_FEED_LIMIT = 100;

const DAY_MS = 86_400_000;

/* ── Shapes ────────────────────────────────────────────────────────── */

export type FeedStatus = 'ok' | 'error';

export interface IcsFeedDocument {
  feedId: string;
  label: string | null;
  encryptedUrl: EncryptedField;
  hostHash: string;
  autoAcceptDeadlines: boolean;
  status: FeedStatus;
  consecutiveFailures: number;
  /** A `SafeFetchError`/`FieldEncryptionError` code or `not_a_calendar`; never a message. */
  lastErrorCode: string | null;
  etag: string | null;
  lastModified: string | null;
  lastFetchedAt: string | null;
  lastFullFetchAt: string | null;
  lastManualRefreshAt: string | null;
  nextFetchAt: string;
  createdAt: string;
  busyBlocks: number;
}

export type ItemState = 'pending' | 'accepted' | 'rejected' | 'withdrawn';
export type ItemNotice = 'moved' | 'removed' | null;

export interface IcsFeedItemDocument {
  itemKey: string;
  feedId: string;
  recurrenceId: string | null;
  sequence: number;
  dtstamp: string | null;
  title: string;
  dueAt: string;
  allDay: boolean;
  state: ItemState;
  notice: ItemNotice;
  /** For a "moved" notice: the time the feed now says. */
  proposedDueAt: string | null;
  commitmentId: string | null;
  autoAccepted: boolean;
  /** A dismissed item that changed comes back once; this records that it has. */
  reappeared: boolean;
  firstSeenAt: string;
  updatedAt: string;
}

/** What the phone sees of a feed. No URL, no host, no host hash. */
export interface IcsFeedView {
  feedId: string;
  label: string | null;
  autoAcceptDeadlines: boolean;
  status: FeedStatus;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastFetchedAt: string | null;
  nextFetchAt: string;
  busyBlocks: number;
  pendingDeadlines: number;
}

export interface IcsDeadlineView {
  itemKey: string;
  feedId: string;
  title: string;
  dueAt: string;
  allDay: boolean;
  state: ItemState;
  notice: ItemNotice;
  proposedDueAt: string | null;
  commitmentId: string | null;
  autoAccepted: boolean;
}

export interface IcsPreview {
  deadlines: number;
  busyBlocks: number;
  skipped: number;
}

export type IcsFeedErrorCode =
  | 'feature_disabled'
  | 'invalid_request'
  | 'invalid_url'
  | 'too_many_feeds'
  | 'feed_not_found'
  | 'item_not_found'
  | 'refresh_too_soon'
  | 'fetch_failed'
  | 'not_a_calendar'
  | 'invalid_action'
  | 'past_due'
  | 'encryption_unavailable';

const STATUS: Record<IcsFeedErrorCode, number> = {
  feature_disabled: 404,
  invalid_request: 400,
  invalid_url: 400,
  too_many_feeds: 409,
  feed_not_found: 404,
  item_not_found: 404,
  refresh_too_soon: 429,
  fetch_failed: 422,
  not_a_calendar: 422,
  invalid_action: 409,
  past_due: 409,
  encryption_unavailable: 503,
};

/** A refusal a route can answer as it stands: fixed message, a code, a status, and a detail code at most. */
export class IcsFeedError extends Error {
  readonly code: IcsFeedErrorCode;
  readonly status: number;
  readonly detail: string | null;

  constructor(code: IcsFeedErrorCode, detail: string | null = null) {
    super(`ics feed: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'IcsFeedError';
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
  }
}

/**
 * Storage is the process's adapter (`setStorageForTests` in tests), never an
 * injected one: accepting a deadline commits through `participantState`, which
 * has no other, and a service half on one adapter and half on another is a
 * test that passes against a store production never uses.
 */
export interface IcsFeedDeps {
  now?: () => Date;
  fetch?: (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;
  encryption?: FieldEncryptionOptions;
  log?: (line: string) => void;
}

/** Enable flag: off unless the value is exactly `true`. */
export function icsFeedsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ICS_FEEDS_ENABLED === 'true';
}

function storageOf(_deps: IcsFeedDeps): StorageAdapter {
  return getStorage();
}

function nowOf(deps: IcsFeedDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function logOf(deps: IcsFeedDeps): (line: string) => void {
  return deps.log ?? ((line) => console.info(line));
}

export function icsSourceId(feedId: string): string {
  return `ics:${feedId}`;
}

export function icsItemKey(feedId: string, uid: string, recurrenceId: string | null): string {
  return createHash('sha256').update(JSON.stringify([feedId, uid, recurrenceId ?? ''])).digest('hex');
}

const FEED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ITEM_KEY = /^[0-9a-f]{64}$/;

function feedPath(uid: string, feedId: string): string {
  if (!FEED_ID.test(feedId)) throw new IcsFeedError('feed_not_found');
  return userSubDoc(uid, ICS_FEEDS, feedId);
}

function itemPath(uid: string, itemKey: string): string {
  if (!ITEM_KEY.test(itemKey)) throw new IcsFeedError('item_not_found');
  return userSubDoc(uid, ICS_FEED_ITEMS, itemKey);
}

/* ── Views ─────────────────────────────────────────────────────────── */

function feedView(feed: IcsFeedDocument, items: readonly IcsFeedItemDocument[]): IcsFeedView {
  // Built field by field: `encryptedUrl` and `hostHash` must not reach the
  // phone, and a spread would carry them the day someone forgets.
  return {
    feedId: feed.feedId,
    label: feed.label,
    autoAcceptDeadlines: feed.autoAcceptDeadlines,
    status: feed.status,
    consecutiveFailures: feed.consecutiveFailures,
    lastErrorCode: feed.lastErrorCode,
    lastFetchedAt: feed.lastFetchedAt,
    nextFetchAt: feed.nextFetchAt,
    busyBlocks: feed.busyBlocks,
    pendingDeadlines: items.filter((item) => item.feedId === feed.feedId && item.state === 'pending').length,
  };
}

function deadlineView(item: IcsFeedItemDocument): IcsDeadlineView {
  return {
    itemKey: item.itemKey,
    feedId: item.feedId,
    title: item.title,
    dueAt: item.dueAt,
    allDay: item.allDay,
    state: item.state,
    notice: item.notice,
    proposedDueAt: item.proposedDueAt,
    commitmentId: item.commitmentId,
    autoAccepted: item.autoAccepted,
  };
}

async function readFeeds(uid: string, deps: IcsFeedDeps): Promise<IcsFeedDocument[]> {
  const rows = await storageOf(deps).list<IcsFeedDocument>(userCol(uid, ICS_FEEDS));
  return rows.map((row) => row.data).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

async function readItems(uid: string, deps: IcsFeedDeps): Promise<IcsFeedItemDocument[]> {
  const rows = await storageOf(deps).list<IcsFeedItemDocument>(userCol(uid, ICS_FEED_ITEMS));
  return rows.map((row) => row.data);
}

async function readFeed(uid: string, feedId: string, deps: IcsFeedDeps): Promise<IcsFeedDocument> {
  const feed = await storageOf(deps).get<IcsFeedDocument>(feedPath(uid, feedId));
  if (!feed) throw new IcsFeedError('feed_not_found');
  return feed;
}

export async function listIcsFeeds(uid: string, deps: IcsFeedDeps = {}): Promise<IcsFeedView[]> {
  requireUserId(uid);
  const [feeds, items] = await Promise.all([readFeeds(uid, deps), readItems(uid, deps)]);
  return feeds.map((feed) => feedView(feed, items));
}

/**
 * What needs the user: pending proposals, and accepted items carrying a notice
 * or auto-accepted in the last week (so Undo is reachable). Soonest first.
 */
export async function listIcsDeadlines(uid: string, deps: IcsFeedDeps = {}): Promise<IcsDeadlineView[]> {
  requireUserId(uid);
  const now = nowOf(deps).getTime();
  const items = await readItems(uid, deps);
  return items
    .filter((item) => item.state === 'pending'
      || (item.state === 'accepted' && (item.notice !== null
        || (item.autoAccepted && Date.parse(item.updatedAt) > now - 7 * DAY_MS))))
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.itemKey < b.itemKey ? -1 : 1))
    .map(deadlineView);
}

/* ── Input ─────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuseUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new IcsFeedError('invalid_request');
}

function labelFrom(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new IcsFeedError('invalid_request');
  const label = cleanTitle(value);
  if (Array.from(label).length > MAX_LABEL_LENGTH) throw new IcsFeedError('invalid_request');
  return label === '' ? null : label;
}

function booleanFrom(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new IcsFeedError('invalid_request');
  return value;
}

async function userTimeZone(uid: string, deps: IcsFeedDeps): Promise<string> {
  const user = await storageOf(deps).get<UserDocument>(userDoc(uid));
  return user?.timezone ?? DEFAULT_MOBILE_TIMEZONE;
}

/* ── Due-feed index on the user document ───────────────────────────── */

type IcsIndexedUser = UserDocument & { icsNextFetchAt?: string };

/**
 * `users/{uid}.icsNextFetchAt` is the earliest `nextFetchAt` of this account's
 * feeds, or absent. The refresh job reads due accounts with one single-field
 * range query on `users` — the same shape the daily-plan sweep uses — rather
 * than a collection-group query, which would need its own index exemption.
 * Absent rather than null, because Firestore ranks null below every string and
 * `<= now` would match an account with no feeds for ever.
 */
async function syncDueIndex(uid: string, deps: IcsFeedDeps): Promise<void> {
  const feeds = await readFeeds(uid, deps);
  const earliest = feeds.map((feed) => feed.nextFetchAt).sort()[0];
  await storageOf(deps).runTransaction(async (tx) => {
    const user = await tx.get<IcsIndexedUser>(userDoc(uid));
    if (!user && earliest === undefined) return;
    const { icsNextFetchAt: _previous, ...rest } = (user ?? newUserDocument(new Date().toISOString())) as IcsIndexedUser;
    tx.set(userDoc(uid), earliest === undefined ? rest : { ...rest, icsNextFetchAt: earliest });
  });
}

/* ── Fetch, classify, apply ────────────────────────────────────────── */

function backoffMs(failures: number): number {
  return Math.min(REFRESH_INTERVAL_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A reminder a day before the deadline, or at it when that has already passed. */
function reminderFor(dueAtMs: number, nowMs: number): string {
  const dayBefore = dueAtMs - DAY_MS;
  return iso(dayBefore > nowMs ? dayBefore : dueAtMs);
}

/**
 * The commands for one deadline. `commitmentId` and the reminder id are passed
 * in rather than minted here because this runs inside a transaction that
 * retries, and a fresh uuid per attempt would make the callback impure.
 */
function commitmentCommands(
  item: Pick<IcsFeedItemDocument, 'title' | 'dueAt'>,
  now: Date,
  ids: { commitmentId: string; reminderId: string },
): { commitmentId: string; commands: Command[] } {
  const commitmentId = ids.commitmentId;
  const at = now.toISOString();
  const remindAt = reminderFor(Date.parse(item.dueAt), now.getTime());
  return {
    commitmentId,
    commands: [
      {
        type: 'CreateDraft',
        now: at,
        commitment: {
          id: commitmentId,
          kind: 'task',
          title: item.title,
          description: null,
          person: null,
          priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
          category: null,
          timeSpec: { kind: 'due_by', dueAt: item.dueAt, remindAt, timezone: 'UTC' },
        },
        draftStatus: 'pending_confirmation',
      },
      {
        type: 'ConfirmCommitment',
        commitmentId,
        now: at,
        reminders: [{ id: ids.reminderId, reminderType: 'due_soon', scheduledFor: remindAt, requiresAction: true }],
      },
    ],
  };
}

/**
 * Creates the commitment for an item and marks it accepted, atomically. A
 * second call for an item already accepted writes nothing.
 */
async function acceptItem(
  uid: string,
  itemKey: string,
  now: Date,
  autoAccepted: boolean,
): Promise<{ replayed: boolean }> {
  const path = itemPath(uid, itemKey);
  const ids = { commitmentId: randomUUID(), reminderId: randomUUID() };
  return commitCommandsWithClaim<IcsFeedItemDocument>(uid, path, (claim) => {
    if (!claim) throw new IcsFeedError('item_not_found');
    // Already accepted: the commitment exists, and this is a replay.
    if (claim.state === 'accepted') return null;
    // Dismissed, withdrawn, or accepted-then-undone. The row has moved on since
    // the caller read it, and a feed item that is not pending is not an offer.
    if (claim.state !== 'pending') throw new IcsFeedError('invalid_action');
    // The title and the time come from the row *this transaction* read. A
    // refresh that moved the deadline between the caller's read and this write
    // would otherwise make a commitment for the time the feed no longer says.
    const { commands } = commitmentCommands(claim, now, ids);
    return {
      commands,
      patch: {
        state: 'accepted',
        commitmentId: ids.commitmentId,
        autoAccepted,
        notice: null,
        proposedDueAt: null,
        updatedAt: now.toISOString(),
      },
    };
  });
}

interface ApplyOutcome {
  created: number;
  updated: number;
  withdrawn: number;
  autoAccepted: number;
}

/**
 * Reconciles one classification against the rows this feed already has.
 * See the header for the rules. Writes only this feed's rows.
 */
async function reconcileDeadlines(
  uid: string,
  feed: IcsFeedDocument,
  classification: IcsClassification,
  now: Date,
  deps: IcsFeedDeps,
): Promise<ApplyOutcome> {
  const storage = storageOf(deps);
  const nowMs = now.getTime();
  const at = now.toISOString();
  const outcome: ApplyOutcome = { created: 0, updated: 0, withdrawn: 0, autoAccepted: 0 };
  const existing = new Map((await readItems(uid, deps))
    .filter((item) => item.feedId === feed.feedId)
    .map((item) => [item.itemKey, item]));
  const seen = new Set<string>();
  const toAutoAccept: string[] = [];

  for (const candidate of classification.deadlines) {
    const key = icsItemKey(feed.feedId, candidate.uid, candidate.recurrenceId);
    if (seen.has(key)) continue;
    seen.add(key);
    const row = existing.get(key);

    if (!row) {
      const item: IcsFeedItemDocument = {
        itemKey: key,
        feedId: feed.feedId,
        recurrenceId: candidate.recurrenceId,
        sequence: candidate.sequence,
        dtstamp: candidate.dtstamp,
        title: candidate.title,
        dueAt: candidate.dueAt,
        allDay: candidate.allDay,
        state: 'pending',
        notice: null,
        proposedDueAt: null,
        commitmentId: null,
        autoAccepted: false,
        reappeared: false,
        firstSeenAt: at,
        updatedAt: at,
      };
      await storage.set(itemPath(uid, key), item);
      outcome.created += 1;
      if (feed.autoAcceptDeadlines) toAutoAccept.push(key);
      continue;
    }

    const next = reconcileRow(row, candidate, at);
    if (next) {
      await storage.set(itemPath(uid, key), next);
      outcome.updated += 1;
    }
  }

  // Gone from the feed. Only an item that would still be *inside* the window
  // can be judged missing: one whose due time has passed simply aged out, and
  // one beyond the last deadline kept under the cap was cut, not removed.
  const capped = classification.skipped.some((entry) => entry.reason === 'over_cap')
    && classification.deadlines.length >= MAX_DEADLINES;
  const lastKept = classification.deadlines[classification.deadlines.length - 1]?.dueAt;
  const windowEnd = nowMs + DEADLINE_WINDOW_DAYS * DAY_MS;
  for (const row of Array.from(existing.values())) {
    if (seen.has(row.itemKey)) continue;
    const due = Date.parse(row.dueAt);
    const judged = row.state === 'accepted' && row.proposedDueAt ? Date.parse(row.proposedDueAt) : due;
    const inWindow = judged >= nowMs && judged <= windowEnd && !(capped && lastKept !== undefined && row.dueAt > lastKept);
    if (inWindow) {
      if (row.state === 'pending') {
        await storage.set(itemPath(uid, row.itemKey), { ...row, state: 'withdrawn', updatedAt: at });
        outcome.withdrawn += 1;
      } else if (row.state === 'accepted' && row.notice !== 'removed') {
        await storage.set(itemPath(uid, row.itemKey), { ...row, notice: 'removed', proposedDueAt: null, updatedAt: at });
        outcome.updated += 1;
      }
    } else if (due < nowMs - ITEM_RETENTION_MS) {
      await storage.delete(itemPath(uid, row.itemKey));
    }
  }

  for (const key of toAutoAccept) {
    try {
      const result = await acceptItem(uid, key, now, true);
      if (!result.replayed) outcome.autoAccepted += 1;
    } catch (error) {
      // Left pending: the user can still accept it by hand.
      logOf(deps)(`[ics] auto-accept failed feed=${feed.feedId} host=${feed.hostHash} error=${error instanceof Error ? error.name : 'unknown'}`);
    }
  }
  return outcome;
}

/** The row after seeing `candidate` again, or null when nothing changes. */
export function reconcileRow(
  row: IcsFeedItemDocument,
  candidate: DeadlineCandidate,
  at: string,
): IcsFeedItemDocument | null {
  if (candidate.sequence < row.sequence) return null;
  const moved = candidate.dueAt !== (row.state === 'accepted' && row.proposedDueAt ? row.proposedDueAt : row.dueAt);
  const retitled = candidate.title !== row.title;
  const bookkeeping = { sequence: candidate.sequence, dtstamp: candidate.dtstamp, updatedAt: at };

  if (!moved && !retitled) {
    // Revived after being withdrawn, or a notice that no longer holds.
    if (row.state === 'withdrawn') return { ...row, ...bookkeeping, state: 'pending' };
    if (row.state === 'accepted' && row.notice === 'removed') return { ...row, ...bookkeeping, notice: null };
    return null;
  }

  switch (row.state) {
    case 'pending':
      return { ...row, ...bookkeeping, title: candidate.title, dueAt: candidate.dueAt, allDay: candidate.allDay };
    case 'withdrawn':
      return { ...row, ...bookkeeping, title: candidate.title, dueAt: candidate.dueAt, allDay: candidate.allDay, state: 'pending' };
    case 'rejected':
      if (row.reappeared || !moved) return { ...row, ...bookkeeping };
      return {
        ...row, ...bookkeeping, title: candidate.title, dueAt: candidate.dueAt, allDay: candidate.allDay,
        state: 'pending', reappeared: true,
      };
    case 'accepted':
      // The commitment is the user's now. A new title alone is not worth a
      // notice; a new time is, and it waits for them to apply it.
      if (!moved) return { ...row, ...bookkeeping };
      if (candidate.dueAt === row.dueAt) return { ...row, ...bookkeeping, notice: null, proposedDueAt: null };
      return { ...row, ...bookkeeping, notice: 'moved', proposedDueAt: candidate.dueAt };
    default:
      return null;
  }
}

async function applyClassification(
  uid: string,
  feed: IcsFeedDocument,
  classification: IcsClassification,
  now: Date,
  deps: IcsFeedDeps,
): Promise<{ busyBlocks: number; outcome: ApplyOutcome }> {
  const sourceId = icsSourceId(feed.feedId);
  const blocks = new Map<string, BusyBlock>();
  for (const busy of classification.busy) {
    const blockId = busyBlockId(sourceId, JSON.stringify([busy.uid, busy.recurrenceId ?? '']), busy.startAt);
    blocks.set(blockId, {
      blockId, sourceId, sourceKind: 'ics', startAt: busy.startAt, endAt: busy.endAt, allDay: false,
    });
  }
  const window = { startsAt: now.toISOString(), endsAt: iso(now.getTime() + BUSY_WINDOW_DAYS * DAY_MS) };
  await replaceBusyBlocks(uid, sourceId, window, Array.from(blocks.values()), { platform: null, now });
  const outcome = await reconcileDeadlines(uid, feed, classification, now, deps);
  return { busyBlocks: blocks.size, outcome };
}

function fetchWith(deps: IcsFeedDeps): (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult> {
  return deps.fetch ?? safeFetch;
}

/* ── Create ────────────────────────────────────────────────────────── */

export interface CreateIcsFeedResult {
  feed: IcsFeedView;
  preview: IcsPreview;
}

export async function createIcsFeed(uid: string, body: unknown, deps: IcsFeedDeps = {}): Promise<CreateIcsFeedResult> {
  requireUserId(uid);
  if (!isRecord(body)) throw new IcsFeedError('invalid_request');
  refuseUnknownKeys(body, ['url', 'label', 'autoAcceptDeadlines']);
  const label = labelFrom(body.label);
  const autoAcceptDeadlines = booleanFrom(body.autoAcceptDeadlines, false);

  let url: URL;
  try {
    url = normalizeFeedUrl(body.url);
  } catch (error) {
    if (error instanceof SafeFetchError) throw new IcsFeedError('invalid_url', error.code);
    throw error;
  }

  const existing = await readFeeds(uid, deps);
  if (existing.length >= MAX_FEEDS_PER_USER) throw new IcsFeedError('too_many_feeds');

  const now = nowOf(deps);
  const feedId = randomUUID();
  const hostHash = hostHashOf(url.hostname);
  const log = logOf(deps);

  // Fetched and read before anything is stored: a link that is not a calendar
  // is refused at the paste, not discovered six hours later.
  let fetched: SafeFetchResult;
  try {
    fetched = await fetchWith(deps)(url.href, {});
  } catch (error) {
    const code = error instanceof SafeFetchError ? error.code : 'network';
    log(`[ics] subscribe fetch refused feed=${feedId} host=${hostHash} code=${code}`);
    if (error instanceof SafeFetchError && error.code.startsWith('blocked_')) throw new IcsFeedError('invalid_url', code);
    throw new IcsFeedError('fetch_failed', code);
  }
  if (fetched.notModified) throw new IcsFeedError('fetch_failed', 'http_status');

  const timeZone = await userTimeZone(uid, deps);
  let classification: IcsClassification;
  try {
    classification = classifyIcs(fetched.body, { now, timeZone });
  } catch (error) {
    if (error instanceof IcsParseError) throw new IcsFeedError('not_a_calendar');
    throw error;
  }

  let encryptedUrl: EncryptedField;
  try {
    encryptedUrl = await encryptField(uid, fieldPurpose('ics-url', feedId), url.href, deps.encryption);
  } catch (error) {
    if (error instanceof FieldEncryptionError) {
      log(`[ics] subscribe could not encrypt feed=${feedId} code=${error.code}`);
      throw new IcsFeedError('encryption_unavailable', error.code);
    }
    throw error;
  }

  const feed: IcsFeedDocument = {
    feedId,
    label,
    encryptedUrl,
    hostHash,
    autoAcceptDeadlines,
    status: 'ok',
    consecutiveFailures: 0,
    lastErrorCode: null,
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    lastFetchedAt: now.toISOString(),
    lastFullFetchAt: now.toISOString(),
    lastManualRefreshAt: null,
    nextFetchAt: iso(now.getTime() + REFRESH_INTERVAL_MS),
    createdAt: now.toISOString(),
    busyBlocks: 0,
  };
  await storageOf(deps).set(feedPath(uid, feedId), feed);
  const applied = await applyClassification(uid, feed, classification, now, deps);
  const stored: IcsFeedDocument = { ...feed, busyBlocks: applied.busyBlocks };
  await storageOf(deps).set(feedPath(uid, feedId), stored);
  await syncDueIndex(uid, deps);
  log(`[ics] subscribed feed=${feedId} host=${hostHash} deadlines=${classification.deadlines.length} busy=${applied.busyBlocks}`);

  return {
    feed: feedView(stored, await readItems(uid, deps)),
    preview: {
      deadlines: classification.deadlines.length,
      busyBlocks: applied.busyBlocks,
      skipped: classification.skipped.reduce((sum, entry) => sum + (entry.reason === 'timezone_fallback' ? 0 : entry.count), 0),
    },
  };
}

/* ── Refresh ───────────────────────────────────────────────────────── */

export type RefreshOutcome = 'updated' | 'not_modified' | 'failed' | 'kms_retry';

export async function refreshIcsFeed(
  uid: string,
  feedId: string,
  options: { manual: boolean },
  deps: IcsFeedDeps = {},
): Promise<{ outcome: RefreshOutcome; feed: IcsFeedView }> {
  requireUserId(uid);
  const storage = storageOf(deps);
  const now = nowOf(deps);
  const nowMs = now.getTime();
  const log = logOf(deps);
  let feed = await readFeed(uid, feedId, deps);

  if (options.manual) {
    if (feed.lastManualRefreshAt && nowMs - Date.parse(feed.lastManualRefreshAt) < MANUAL_REFRESH_COOLDOWN_MS) {
      throw new IcsFeedError('refresh_too_soon');
    }
    feed = { ...feed, lastManualRefreshAt: now.toISOString() };
  }

  const fail = async (code: string): Promise<{ outcome: RefreshOutcome; feed: IcsFeedView }> => {
    const failures = feed.consecutiveFailures + 1;
    const next: IcsFeedDocument = {
      ...feed,
      consecutiveFailures: failures,
      lastErrorCode: code,
      status: failures >= FAILURES_BEFORE_ERROR ? 'error' : feed.status,
      nextFetchAt: iso(nowMs + backoffMs(failures)),
    };
    await storage.set(feedPath(uid, feedId), next);
    await syncDueIndex(uid, deps);
    log(`[ics] refresh failed feed=${feedId} host=${feed.hostHash} code=${code} failures=${failures}`);
    return { outcome: 'failed', feed: feedView(next, await readItems(uid, deps)) };
  };

  let url: string;
  try {
    url = await decryptField(uid, fieldPurpose('ics-url', feedId), feed.encryptedUrl, deps.encryption);
  } catch (error) {
    if (error instanceof FieldEncryptionError && (error.code === 'kms_unavailable' || error.code === 'not_configured')) {
      // Not a verdict on the stored value, and not the feed's fault: retry
      // soon, count nothing, and never clear the blob.
      const next: IcsFeedDocument = { ...feed, nextFetchAt: iso(nowMs + KMS_RETRY_MS) };
      await storage.set(feedPath(uid, feedId), next);
      await syncDueIndex(uid, deps);
      log(`[ics] refresh deferred feed=${feedId} host=${feed.hostHash} code=${error.code}`);
      return { outcome: 'kms_retry', feed: feedView(next, await readItems(uid, deps)) };
    }
    // decrypt_failed / malformed_blob: counted, and the blob is kept.
    return fail(error instanceof FieldEncryptionError ? error.code : 'decrypt_failed');
  }

  const conditional = feed.lastFullFetchAt !== null && nowMs - Date.parse(feed.lastFullFetchAt) < CONDITIONAL_FETCH_MAX_AGE_MS;
  let fetched: SafeFetchResult;
  try {
    fetched = await fetchWith(deps)(url, conditional ? { etag: feed.etag, lastModified: feed.lastModified } : {});
  } catch (error) {
    return fail(error instanceof SafeFetchError ? error.code : 'network');
  }

  if (fetched.notModified) {
    const next: IcsFeedDocument = {
      ...feed,
      status: 'ok',
      consecutiveFailures: 0,
      lastErrorCode: null,
      lastFetchedAt: now.toISOString(),
      nextFetchAt: iso(nowMs + REFRESH_INTERVAL_MS),
    };
    await storage.set(feedPath(uid, feedId), next);
    await syncDueIndex(uid, deps);
    log(`[ics] refresh not modified feed=${feedId} host=${feed.hostHash}`);
    return { outcome: 'not_modified', feed: feedView(next, await readItems(uid, deps)) };
  }

  let classification: IcsClassification;
  try {
    classification = classifyIcs(fetched.body, { now, timeZone: await userTimeZone(uid, deps) });
  } catch (error) {
    if (error instanceof IcsParseError) return fail('not_a_calendar');
    throw error;
  }

  const applied = await applyClassification(uid, feed, classification, now, deps);
  const next: IcsFeedDocument = {
    ...feed,
    status: 'ok',
    consecutiveFailures: 0,
    lastErrorCode: null,
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    lastFetchedAt: now.toISOString(),
    lastFullFetchAt: now.toISOString(),
    nextFetchAt: iso(nowMs + REFRESH_INTERVAL_MS),
    busyBlocks: applied.busyBlocks,
  };
  await storage.set(feedPath(uid, feedId), next);
  await syncDueIndex(uid, deps);
  log(`[ics] refreshed feed=${feedId} host=${feed.hostHash} created=${applied.outcome.created} updated=${applied.outcome.updated} withdrawn=${applied.outcome.withdrawn} auto=${applied.outcome.autoAccepted} busy=${applied.busyBlocks}`);
  return { outcome: 'updated', feed: feedView(next, await readItems(uid, deps)) };
}

/* ── Update and delete ─────────────────────────────────────────────── */

export async function updateIcsFeed(uid: string, feedId: string, body: unknown, deps: IcsFeedDeps = {}): Promise<IcsFeedView> {
  requireUserId(uid);
  if (!isRecord(body)) throw new IcsFeedError('invalid_request');
  refuseUnknownKeys(body, ['label', 'autoAcceptDeadlines']);
  const feed = await readFeed(uid, feedId, deps);
  const next: IcsFeedDocument = {
    ...feed,
    ...(body.label !== undefined ? { label: labelFrom(body.label) } : {}),
    autoAcceptDeadlines: booleanFrom(body.autoAcceptDeadlines, feed.autoAcceptDeadlines),
  };
  await storageOf(deps).set(feedPath(uid, feedId), next);
  // Turning auto-accept on does not sweep what is already pending: those were
  // proposed while it was off, and the user may be halfway through them.
  return feedView(next, await readItems(uid, deps));
}

/**
 * Unsubscribe: the encrypted URL, every busy block the feed wrote, and every
 * row it proposed. Commitments the user accepted are theirs and stay.
 */
export async function deleteIcsFeed(uid: string, feedId: string, deps: IcsFeedDeps = {}): Promise<{ busyBlocks: number; proposals: number }> {
  requireUserId(uid);
  const storage = storageOf(deps);
  const path = feedPath(uid, feedId);
  const feed = await storage.get<IcsFeedDocument>(path);
  if (!feed) throw new IcsFeedError('feed_not_found');
  const busy = await deleteBusySource(uid, icsSourceId(feedId));
  const items = (await readItems(uid, deps)).filter((item) => item.feedId === feedId);
  for (const item of items) await storage.delete(itemPath(uid, item.itemKey));
  await storage.delete(path);
  await syncDueIndex(uid, deps);
  logOf(deps)(`[ics] unsubscribed feed=${feedId} host=${feed.hostHash}`);
  return { busyBlocks: busy.deleted, proposals: items.filter((item) => item.state === 'pending').length };
}

/* ── The user's answer to one deadline ─────────────────────────────── */

export type DeadlineAction = 'accept' | 'dismiss' | 'undo' | 'apply_move' | 'acknowledge';
const ACTIONS: readonly DeadlineAction[] = ['accept', 'dismiss', 'undo', 'apply_move', 'acknowledge'];

export async function decideIcsDeadline(
  uid: string,
  feedId: string,
  itemKey: string,
  body: unknown,
  deps: IcsFeedDeps = {},
): Promise<{ deadline: IcsDeadlineView; replayed: boolean }> {
  requireUserId(uid);
  if (!isRecord(body)) throw new IcsFeedError('invalid_request');
  refuseUnknownKeys(body, ['action']);
  const action = body.action as DeadlineAction;
  if (!ACTIONS.includes(action)) throw new IcsFeedError('invalid_request');

  const storage = storageOf(deps);
  await readFeed(uid, feedId, deps);
  const path = itemPath(uid, itemKey);
  const item = await storage.get<IcsFeedItemDocument>(path);
  if (!item || item.feedId !== feedId) throw new IcsFeedError('item_not_found');
  const now = nowOf(deps);
  const at = now.toISOString();
  let replayed = false;

  switch (action) {
    case 'accept': {
      // The same rule every other way of making a commitment follows (#352).
      if (item.state === 'pending' && Date.parse(item.dueAt) < now.getTime()) throw new IcsFeedError('past_due');
      // Whether this row may still be accepted is decided *inside* the
      // transaction, by `acceptItem`, and not here. The read above is a moment
      // old: a dismissal, or another tap, can land between it and the write,
      // and a check here would answer from a row that had already changed.
      replayed = (await acceptItem(uid, itemKey, now, false)).replayed;
      break;
    }
    case 'dismiss': {
      if (item.state === 'rejected') { replayed = true; break; }
      if (item.state !== 'pending') throw new IcsFeedError('invalid_action');
      await storage.set(path, { ...item, state: 'rejected', updatedAt: at });
      break;
    }
    case 'undo': {
      // Only what the feed accepted on the user's behalf. Something they
      // accepted themselves is a commitment like any other, with its own
      // controls in the app.
      if (item.state === 'rejected' && item.autoAccepted) { replayed = true; break; }
      if (item.state !== 'accepted' || !item.autoAccepted || !item.commitmentId) throw new IcsFeedError('invalid_action');
      await applyParticipantCommand(uid, { type: 'Drop', commitmentId: item.commitmentId, now: at });
      await storage.set(path, { ...item, state: 'rejected', notice: null, proposedDueAt: null, updatedAt: at });
      break;
    }
    case 'apply_move': {
      if (item.state !== 'accepted' || item.notice !== 'moved' || !item.proposedDueAt || !item.commitmentId) {
        throw new IcsFeedError('invalid_action');
      }
      if (Date.parse(item.proposedDueAt) < now.getTime()) throw new IcsFeedError('past_due');
      const remindAt = reminderFor(Date.parse(item.proposedDueAt), now.getTime());
      const result = await applyParticipantCommand(uid, {
        type: 'UpdateCommitment',
        commitmentId: item.commitmentId,
        now: at,
        updates: { timeSpec: { kind: 'due_by', dueAt: item.proposedDueAt, remindAt } },
      });
      if (result.result !== 'applied' && result.result !== 'noop') throw new IcsFeedError('invalid_action');
      await storage.set(path, { ...item, dueAt: item.proposedDueAt, notice: null, proposedDueAt: null, updatedAt: at });
      break;
    }
    case 'acknowledge': {
      if (item.notice === null) { replayed = true; break; }
      await storage.set(path, { ...item, notice: null, proposedDueAt: null, updatedAt: at });
      break;
    }
  }

  const stored = await storage.get<IcsFeedItemDocument>(path);
  return { deadline: deadlineView(stored ?? item), replayed };
}

/* ── The scheduled sweep ───────────────────────────────────────────── */

export interface IcsRefreshTickTotals {
  accounts: number;
  due: number;
  updated: number;
  notModified: number;
  failed: number;
  deferred: number;
}

export async function runIcsRefreshTick(
  options: IcsFeedDeps & { limit?: number; budgetMs?: number; clock?: () => number } = {},
): Promise<IcsRefreshTickTotals> {
  const now = nowOf(options);
  const storage = storageOf(options);
  const limit = options.limit ?? REFRESH_TICK_FEED_LIMIT;
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budget = options.budgetMs ?? 45_000;
  const totals: IcsRefreshTickTotals = { accounts: 0, due: 0, updated: 0, notModified: 0, failed: 0, deferred: 0 };

  const accounts = await storage.list<IcsIndexedUser>(USERS, {
    where: [['icsNextFetchAt', '<=', now.toISOString()]],
    orderBy: { field: 'icsNextFetchAt', direction: 'asc' },
    limit,
  });
  totals.accounts = accounts.length;

  for (const account of accounts) {
    if (totals.due >= limit || clock() - started > budget) break;
    const uid = account.id;
    let feeds: IcsFeedDocument[];
    try {
      feeds = (await readFeeds(uid, options)).filter((feed) => feed.nextFetchAt <= now.toISOString());
      if (feeds.length === 0) await syncDueIndex(uid, options);
    } catch (error) {
      totals.failed += 1;
      console.error('[internal/calendar/ics/refresh] could not read an account\'s feeds', error instanceof Error ? error.name : 'unknown');
      continue;
    }
    for (const feed of feeds) {
      if (totals.due >= limit || clock() - started > budget) break;
      totals.due += 1;
      try {
        const { outcome } = await refreshIcsFeed(uid, feed.feedId, { manual: false }, options);
        if (outcome === 'updated') totals.updated += 1;
        else if (outcome === 'not_modified') totals.notModified += 1;
        else if (outcome === 'kms_retry') totals.deferred += 1;
        else totals.failed += 1;
      } catch (error) {
        totals.failed += 1;
        // The feed id only; an error object from deep inside could carry anything.
        console.error(`[internal/calendar/ics/refresh] feed=${feed.feedId} failed`, error instanceof Error ? error.name : 'unknown');
      }
    }
  }
  return totals;
}

/** Busy blocks this feed currently holds, for tests and the Trust Center. */
export async function icsBusyBlocks(uid: string, feedId: string, deps: IcsFeedDeps = {}): Promise<BusyBlock[]> {
  const now = nowOf(deps).getTime();
  const all = await listBusyBlocks(uid, { startsAt: iso(now - 400 * DAY_MS), endsAt: iso(now + 400 * DAY_MS) });
  return all.filter((block) => block.sourceId === icsSourceId(feedId));
}
