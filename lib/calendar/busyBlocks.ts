/**
 * Busy time, from whichever calendar it came from (UC-3.2, #186).
 *
 * One module, because UC-3.3 (#187) and UC-3.4 (#188) add a *source* and not a
 * feature: a Google account and an ICS feed produce the same six fields as a
 * phone does, and the planner, the conflict hints and account deletion all have
 * to keep working without knowing which of the three a row came from.
 *
 * ── The six fields, and the ones that are not here ───────────────
 *
 * `blockId`, `sourceId`, `sourceKind`, `startAt`, `endAt`, `allDay`. There is
 * no title, no notes, no location and no attendee — not omitted from a wider
 * record, but never received. `parseBusyUpload` below *refuses* a body that
 * carries one rather than dropping it, and that distinction is the whole point:
 * a route that silently trimmed a title would be a route that had stopped being
 * able to tell anyone whether one had ever arrived.
 *
 * It matters more here than it did in UC-3.1 (#185). The Flutter bridge that
 * preceded this never let an event title cross into the app at all; the
 * `expo-calendar` read does, in JS memory, which means the guarantee moved from
 * "the platform cannot" to "this code does not". So it is written down, it is
 * enforced at the one boundary data crosses, and it is tested by asserting the
 * *key set* rather than the absence of one key somebody thought of.
 *
 * ── An upload is a source's whole state ──────────────────────────
 *
 * A phone re-sends its window: on connect, on manual refresh, when the app
 * comes back to the front, and after UC-3.1 writes an event. So an upload is
 * not a list of new facts — it is that source saying *this is everything I
 * have* — and `replaceBusyBlocks` deletes every row of that source which is not
 * in it, whatever the row's dates.
 *
 * Deleting on overlap with the declared window instead, which is what this did
 * first, is unbounded. The device's window is today's local midnight to +28
 * days, so it *moves* every night, and a row left behind when the date rolled
 * over was outside every later window and could never be a deletion candidate
 * again. One evening event a day left twenty-seven dead rows after twenty-eight
 * days. It compounds rather than merely wasting space, because `listBusyBlocks`
 * reads the whole collection and filters in memory — a design whose only
 * justification is a hard cap per source — and it runs on every daily-plan
 * composition, so building somebody's morning got slower the longer they had
 * the feature on.
 *
 * The whole-state rule closes three things at once: nothing survives a window
 * that moved, the per-source total is bounded by the upload cap because after a
 * sync a source holds exactly what it just sent, and a row dated 2099 — which
 * no honest future window would overlap — is prunable like any other.
 *
 * A source that wanted to sync *incrementally* would need a different function,
 * and would have to say so. None does: there is one window per source at a
 * time, and #187 and #188 both restate a whole feed.
 *
 * ── The block id is namespaced by its source ─────────────────────
 *
 * `blockId` is the document key and it is chosen entirely by the client. The
 * server cannot re-derive it, because the preimage contains the calendar's own
 * event id and that by design never leaves the phone — so "two sources cannot
 * collide" cannot be checked by arithmetic. It is made structural instead: the
 * path hashes the source in with the id, so a second source presenting the same
 * id writes a *different document*. Before that, it overwrote the first
 * source's row and re-filed it under its own name, after which the first
 * phone's "Disconnect and delete" answered `{deleted: 0}` and left the row.
 *
 * ── All-day is stored, and does not block ────────────────────────
 *
 * #186's decision. A birthday, a holiday or "Ramadan" is a day somebody is
 * still able to work in, and turning it into a twenty-four hour blocking event
 * empties the plan. `toFixedEvents` therefore leaves them out by default while
 * `listBusyBlocks` still returns them, so the conflict chip can mention one.
 */
import { createHash } from 'node:crypto';
import type { FixedEvent, Instant, TimeInterval } from '../../src/contracts/v1/planningContracts';
import { getStorage, type StorageAdapter } from '../storage';
import { BUSY_BLOCKS, CALENDAR_SOURCES, docIdForKey, userCol, userSubDoc } from '../storage/paths';

export { BUSY_BLOCKS, CALENDAR_SOURCES };

/** Where a busy block came from. #187 adds `google`, #188 adds `ics`. */
export const BUSY_SOURCE_KINDS = ['device', 'google', 'ics'] as const;
export type BusySourceKind = (typeof BUSY_SOURCE_KINDS)[number];

/**
 * One interval somebody is already spoken for.
 *
 * `allDay` is carried rather than inferred from the interval's length: a
 * twenty-four hour meeting and an all-day entry are different things, and only
 * the calendar knows which it is looking at.
 */
export interface BusyBlock {
  readonly blockId: string;
  readonly sourceId: string;
  readonly sourceKind: BusySourceKind;
  readonly startAt: Instant;
  /** Exclusive, like every other interval in the planning contracts. */
  readonly endAt: Instant;
  readonly allDay: boolean;
}

/** What the account knows about one connected calendar. */
export interface CalendarSource {
  readonly sourceId: string;
  readonly kind: BusySourceKind;
  /** `ios`, `android`, or null for a source that is not a phone. */
  readonly platform: string | null;
  readonly lastSyncedAt: string;
  readonly windowStart: Instant;
  readonly windowEnd: Instant;
}

export interface BusyBlockDeps {
  storage?: StorageAdapter;
}

function storageOf(deps: BusyBlockDeps): StorageAdapter {
  return deps.storage ?? getStorage();
}

/* ── Parsing what a phone sent ───────────────────────────────────── */

export class BusyUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusyUploadError';
  }
}

/**
 * How many blocks one sync may carry.
 *
 * Twenty-eight days of a busy calendar is a few hundred. A thousand is loose
 * enough that nobody real hits it and tight enough that a broken client cannot
 * write a million rows into somebody's tree — and it is a refusal rather than a
 * truncation, because a silently truncated window would leave the tail of the
 * month looking free.
 */
export const BUSY_BLOCK_UPLOAD_LIMIT = 1000;

/**
 * The longest window one upload may declare.
 *
 * Blocks have to fall inside the window they are sent with, or a row dated 2099
 * arrives and nothing ever prunes it. That check is only worth anything if the
 * window itself is bounded: otherwise a client declares a thousand years and
 * every block is "inside" it.
 *
 * The phone sends twenty-eight days. A year and a bit leaves room for an ICS
 * feed (UC-3.4, #188) that publishes a whole academic year without making the
 * bound meaningless.
 */
export const MAX_BUSY_WINDOW_DAYS = 400;

/** The complete list of keys a block may carry. Anything else is an incident. */
export const BUSY_BLOCK_UPLOAD_KEYS = ['blockId', 'startAt', 'endAt', 'allDay'] as const;

/** The complete list of keys the envelope may carry. */
const UPLOAD_ENVELOPE_KEYS = ['sourceId', 'platform', 'windowStart', 'windowEnd', 'blocks'] as const;

export interface ParsedBusyUpload {
  readonly sourceId: string;
  readonly sourceKind: BusySourceKind;
  readonly platform: string | null;
  readonly window: TimeInterval;
  readonly blocks: readonly {
    readonly blockId: string;
    readonly startAt: Instant;
    readonly endAt: Instant;
    readonly allDay: boolean;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every key that is not on the allowlist, named.
 *
 * Named rather than counted, because the message is the incident report: "a
 * busy upload carried title" is the sentence somebody needs in a log, and
 * "invalid body" is the sentence that makes them go and read the client.
 */
function refuseUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new BusyUploadError(
      `${what} may only carry ${allowed.join(', ')}; this one also carried ${unknown.sort().join(', ')}`,
    );
  }
}

function instantOrThrow(value: unknown, field: string): Instant {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BusyUploadError(`${field} must be an ISO-8601 instant`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new BusyUploadError(`${field} must be an ISO-8601 instant`);
  return new Date(ms).toISOString();
}

/**
 * The kind a source id declares, or a refusal.
 *
 * The prefix is the contract — `device:`, `google:`, `ics:` — so a client
 * cannot invent a fourth kind, and #187's rows are recognisable as Google's the
 * day they arrive without a migration.
 */
export function sourceKindOf(sourceId: unknown): BusySourceKind {
  if (typeof sourceId !== 'string' || sourceId.length > 200) {
    throw new BusyUploadError('sourceId must be a string of at most 200 characters');
  }
  // Defence in depth, not the path check. `sourcePath` hashes this through
  // `docIdForKey`, so nothing here can escape a collection whatever it says —
  // but a newline in an id makes a log line ambiguous and `..` in one is a
  // sentence somebody wrote on purpose. Both are refused rather than hashed
  // into something harmless and forgotten about.
  if (/[\u0000-\u001f\u007f]/.test(sourceId)) {
    throw new BusyUploadError('sourceId must not contain control characters');
  }
  if (sourceId.includes('..')) {
    throw new BusyUploadError('sourceId must not contain ".."');
  }
  const kind = BUSY_SOURCE_KINDS.find((candidate) => sourceId.startsWith(`${candidate}:`));
  if (!kind) {
    throw new BusyUploadError(`sourceId must start with one of ${BUSY_SOURCE_KINDS.map((k) => `${k}:`).join(', ')}`);
  }
  if (sourceId.length === kind.length + 1) throw new BusyUploadError('sourceId must name a source after its kind');
  return kind;
}

export function parseBusyUpload(body: unknown): ParsedBusyUpload {
  if (!isRecord(body)) throw new BusyUploadError('the request body must be an object');
  refuseUnknownKeys(body, UPLOAD_ENVELOPE_KEYS, 'a busy upload');

  const sourceKind = sourceKindOf(body.sourceId);
  const sourceId = body.sourceId as string;

  const platform = body.platform === undefined || body.platform === null ? null : body.platform;
  if (platform !== null && platform !== 'ios' && platform !== 'android') {
    throw new BusyUploadError('platform must be ios or android');
  }

  const windowStart = instantOrThrow(body.windowStart, 'windowStart');
  const windowEnd = instantOrThrow(body.windowEnd, 'windowEnd');
  if (Date.parse(windowEnd) <= Date.parse(windowStart)) {
    throw new BusyUploadError('windowEnd must be after windowStart');
  }
  const windowDays = (Date.parse(windowEnd) - Date.parse(windowStart)) / 86_400_000;
  if (windowDays > MAX_BUSY_WINDOW_DAYS) {
    throw new BusyUploadError(`a busy window may cover at most ${MAX_BUSY_WINDOW_DAYS} days`);
  }
  const window: TimeInterval = { startsAt: windowStart, endsAt: windowEnd };

  if (!Array.isArray(body.blocks)) throw new BusyUploadError('blocks must be an array');
  if (body.blocks.length > BUSY_BLOCK_UPLOAD_LIMIT) {
    throw new BusyUploadError(`a busy upload may carry at most ${BUSY_BLOCK_UPLOAD_LIMIT} blocks`);
  }

  const blocks = body.blocks.map((raw, index) => {
    if (!isRecord(raw)) throw new BusyUploadError(`block ${index} must be an object`);
    refuseUnknownKeys(raw, BUSY_BLOCK_UPLOAD_KEYS, `block ${index}`);
    if (typeof raw.blockId !== 'string' || !/^[0-9a-f]{64}$/.test(raw.blockId)) {
      throw new BusyUploadError(`block ${index}: blockId must be a sha-256 hex digest`);
    }
    if (typeof raw.allDay !== 'boolean') throw new BusyUploadError(`block ${index}: allDay must be a boolean`);
    const startAt = instantOrThrow(raw.startAt, `block ${index}: startAt`);
    const endAt = instantOrThrow(raw.endAt, `block ${index}: endAt`);
    if (Date.parse(endAt) <= Date.parse(startAt)) {
      throw new BusyUploadError(`block ${index}: endAt must be after startAt`);
    }
    // Inside the window it was sent with — overlap, not containment, because an
    // event that began last night and runs into this morning is reported by the
    // device with its true start and is a legitimate part of today's window.
    // Without this a one-hour window could carry a block dated 2099, and since
    // no honest future window would ever hold it, nothing would prune it.
    if (!overlaps({ startAt, endAt }, window)) {
      throw new BusyUploadError(`block ${index}: does not fall inside the declared window`);
    }
    return { blockId: raw.blockId, startAt, endAt, allDay: raw.allDay };
  });

  // One id twice is not a calendar with two events in it; it is a client that
  // has lost track of what it is sending. Refused rather than deduplicated,
  // because the count that comes back would otherwise be a number nobody could
  // reconcile with what they sent.
  const ids = new Set(blocks.map((block) => block.blockId));
  if (ids.size !== blocks.length) {
    throw new BusyUploadError('a busy upload may not carry the same blockId twice');
  }

  return { sourceId, sourceKind, platform, window, blocks };
}

/**
 * The id a block gets, derived rather than minted.
 *
 * Deterministic in the source, the calendar's own id for the event and the
 * event's start, so re-uploading an unchanged calendar rewrites the same rows.
 * The native id is hashed with the rest and never stored: two devices on one
 * account do not learn each other's event ids from this collection.
 *
 * The phone computes the same digest in `mobile/src/features/calendar/
 * busySync.ts`, so the preimage has to be something two runtimes agree on
 * exactly. A JSON array is that: unambiguous whatever the three strings
 * contain, and with no control characters to be mangled on the way through a
 * native crypto bridge. A test on each side pins the same vector, which is the
 * only thing that can catch the two drifting apart.
 */
export function busyBlockId(sourceId: string, nativeId: string, startAt: Instant): string {
  return createHash('sha256').update(JSON.stringify([sourceId, nativeId, startAt])).digest('hex');
}

/* ── Storage ─────────────────────────────────────────────────────── */

function sourcePath(uid: string, sourceId: string): string {
  return userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(sourceId));
}

/**
 * The document one block lives at.
 *
 * The source is hashed in with the id rather than the id being used alone. See
 * the header: the id is the client's to choose and the server cannot re-derive
 * it, so two sources colliding has to be impossible to express rather than
 * something detected after one has overwritten the other.
 */
function blockPath(uid: string, sourceId: string, blockId: string): string {
  return userSubDoc(uid, BUSY_BLOCKS, docIdForKey(`${sourceId}\u001f${blockId}`));
}

function overlaps(block: { startAt: Instant; endAt: Instant }, window: TimeInterval): boolean {
  return Date.parse(block.startAt) < Date.parse(window.endsAt)
    && Date.parse(block.endAt) > Date.parse(window.startsAt);
}

function byStart(left: BusyBlock, right: BusyBlock): number {
  const delta = Date.parse(left.startAt) - Date.parse(right.startAt);
  if (delta !== 0) return delta;
  // A stable tiebreak, so two reads of an unchanged account are the same list.
  return left.blockId < right.blockId ? -1 : left.blockId > right.blockId ? 1 : 0;
}

/**
 * Every block this account holds, whatever its source.
 *
 * One list and a filter in memory rather than a ranged query, deliberately.
 * Firestore indexes a single field inside one collection automatically and a
 * *pair* only with a composite index, so "this source, and overlapping this
 * window" would be a second piece of deployment configuration to keep in step
 * with the code. The volume this saves nothing on, and that is now a property
 * rather than a hope: `replaceBusyBlocks` leaves a source holding exactly what
 * it last sent, so a source's total is bounded by `BUSY_BLOCK_UPLOAD_LIMIT` and
 * a person has one or two sources. It was *not* bounded when the delete half
 * worked on window overlap — see the header.
 */
async function allBlocks(uid: string, deps: BusyBlockDeps): Promise<BusyBlock[]> {
  const rows = await storageOf(deps).list<BusyBlock>(userCol(uid, BUSY_BLOCKS));
  return rows.map((row) => row.data);
}

export async function listBusyBlocks(
  uid: string,
  window: TimeInterval,
  deps: BusyBlockDeps = {},
): Promise<BusyBlock[]> {
  const rows = await allBlocks(uid, deps);
  return rows.filter((block) => overlaps(block, window)).sort(byStart);
}

export async function readCalendarSource(
  uid: string,
  sourceId: string,
  deps: BusyBlockDeps = {},
): Promise<CalendarSource | null> {
  return storageOf(deps).get<CalendarSource>(sourcePath(uid, sourceId));
}

export async function listCalendarSources(uid: string, deps: BusyBlockDeps = {}): Promise<CalendarSource[]> {
  const rows = await storageOf(deps).list<CalendarSource>(userCol(uid, CALENDAR_SOURCES));
  return rows.map((row) => row.data).sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
}

export interface ReplaceBusyBlocksDeps extends BusyBlockDeps {
  /** `ios` or `android` for a phone; null for a source that is not one. */
  platform?: string | null;
  now?: Date;
}

/**
 * What this source holds now, in full.
 *
 * Every row of this source that is not in `blocks` is deleted, whatever its
 * dates, and then `blocks` is written. Not "every row overlapping the window":
 * the device's window moves a day every night, and a row it left behind was
 * outside every later window and survived for ever. The header has the numbers.
 *
 * `window` is still validated and still recorded — a block must overlap it, and
 * it is what the Trust Center shows as the span this source covers — but it is
 * no longer what decides a deletion.
 *
 * Outside a transaction on purpose, and that is now safe for a stated reason
 * rather than an assumed one: the only rows this touches are the ones whose
 * document path hashes *this* source, so two devices cannot reach each other's
 * documents even by presenting the same block id. A transaction over a thousand
 * documents would exceed Firestore's limit for one, and the worst a crash
 * halfway can do is leave the source part-written, which the next sync —
 * fifteen minutes away at most — restates in full.
 */
export async function replaceBusyBlocks(
  uid: string,
  sourceId: string,
  window: TimeInterval,
  blocks: readonly BusyBlock[],
  deps: ReplaceBusyBlocksDeps = {},
): Promise<{ written: number; removed: number }> {
  const storage = storageOf(deps);
  const kind = sourceKindOf(sourceId);
  const keep = new Set(blocks.map((block) => block.blockId));

  const stale = (await allBlocks(uid, deps)).filter((block) => (
    block.sourceId === sourceId && !keep.has(block.blockId)
  ));
  for (const block of stale) await storage.delete(blockPath(uid, sourceId, block.blockId));

  for (const block of blocks) {
    // Rebuilt field by field rather than spread: this is the last place a key
    // the client smuggled past `parseBusyUpload` could reach durable storage,
    // and "only these six" is a property of this literal rather than of every
    // caller's discipline.
    await storage.set<BusyBlock>(blockPath(uid, sourceId, block.blockId), {
      blockId: block.blockId,
      sourceId,
      sourceKind: kind,
      startAt: block.startAt,
      endAt: block.endAt,
      allDay: block.allDay,
    });
  }

  const source: CalendarSource = {
    sourceId,
    kind,
    platform: deps.platform ?? null,
    lastSyncedAt: (deps.now ?? new Date()).toISOString(),
    windowStart: window.startsAt,
    windowEnd: window.endsAt,
  };
  await storage.set<CalendarSource>(sourcePath(uid, sourceId), source);

  return { written: blocks.length, removed: stale.length };
}

/**
 * Disconnect: the source's record and every block it ever wrote.
 *
 * Not window-scoped. "Disconnect and delete" is the answer to "take it back
 * off your servers", and a deletion that left the blocks outside the last
 * synced window behind would be an answer that was not true.
 */
export async function deleteBusySource(
  uid: string,
  sourceId: string,
  deps: BusyBlockDeps = {},
): Promise<{ deleted: number }> {
  const storage = storageOf(deps);
  const mine = (await allBlocks(uid, deps)).filter((block) => block.sourceId === sourceId);
  for (const block of mine) await storage.delete(blockPath(uid, sourceId, block.blockId));
  await storage.delete(sourcePath(uid, sourceId));
  return { deleted: mine.length };
}

/* ── Into the planner ────────────────────────────────────────────── */

export interface ToFixedEventsOptions {
  /**
   * Whether an all-day entry blocks the day.
   *
   * #186's decision is that it does not. A birthday, a public holiday or a
   * multi-day trip is still a day somebody works in, and a planner that treated
   * one as twenty-four hours of unavailable time would answer "nothing fits"
   * for a week in December. They are still returned by `listBusyBlocks`, so the
   * conflict hint can mention one.
   */
  readonly includeAllDay: boolean;
}

export function toFixedEvents(
  blocks: readonly BusyBlock[],
  options: ToFixedEventsOptions,
): FixedEvent[] {
  return blocks
    .filter((block) => options.includeAllDay || !block.allDay)
    .map((block) => ({
      eventId: block.blockId,
      interval: { startsAt: block.startAt, endsAt: block.endAt },
      // Busy is busy: nothing else may be placed inside it. The user did not
      // tell us it was movable, and the planner is not entitled to assume it.
      sourceCommitmentId: null,
      blocking: true,
    }));
}

/**
 * The daily plan's reader (UC-3.10a, #194 step 6).
 *
 * #194 left `BusyBlockReader` as a seam defaulting to `NO_BUSY_BLOCKS` and said
 * in its own test file that "what this cannot prove is that a real calendar
 * reaches this function at all". This is that function. Its shape is #194's
 * three-field projection rather than `BusyBlock`, which is why the all-day rule
 * is applied *here*: by the time a block reaches the daily plan's mapping it is
 * a blocking interval, and there is nothing left in it to decide against.
 */
export async function readBusyBlocksForPlanning(
  uid: string,
  window: { readonly startsAt: Instant; readonly endsAt: Instant },
  deps: BusyBlockDeps = {},
): Promise<readonly { readonly blockId: string; readonly startsAt: Instant; readonly endsAt: Instant }[]> {
  const blocks = await listBusyBlocks(uid, window, deps);
  return toFixedEvents(blocks, { includeAllDay: false }).map((event) => ({
    blockId: event.eventId,
    startsAt: event.interval.startsAt,
    endsAt: event.interval.endsAt,
  }));
}
