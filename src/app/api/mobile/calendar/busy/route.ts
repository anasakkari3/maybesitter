import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { readTrust } from '../../../../../../lib/pilot/pilotTrustStore';
import {
  BusyUploadError,
  deleteBusySource,
  parseBusyUpload,
  replaceBusyBlocks,
  type BusyBlock,
} from '../../../../../../lib/calendar/busyBlocks';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';
import { resolveFreeSlots } from '../../../../../../lib/planning/freeSlots';
import { getStorage, type StoredDoc } from '../../../../../../lib/storage';
import { BUSY_BLOCKS, CALENDAR_SOURCES, ICS_FEEDS, userCol } from '../../../../../../lib/storage/paths';
import type { CalendarSource } from '../../../../../../lib/calendar/busyBlocks';
import type { IcsFeedDocument } from '../../../../../../lib/calendar/icsFeeds';

export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_READ_BLOCKS = 2000;
const STORAGE_LIMIT = MAX_READ_BLOCKS + 1;
const STALE_MS = 26 * HOUR_MS;

type StoredBusy = BusyBlock & { __docId?: string };

function jsonReason(reason: string, status: number): Response {
  return Response.json({ success: false, reason }, { status });
}

function unknownFor(block: BusyBlock, from: string, to: string): { from: string; to: string } | null {
  const start = Date.parse(block.startAt);
  const end = Date.parse(block.endAt);
  const malformed = !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > (24 * 60 + 59) * 60_000;
  if (!malformed) return null;
  const stamps = [block.startAt, block.endAt];
  const parsed = [start, end].filter(Number.isFinite);
  let low: number;
  let high: number;
  if (parsed.length > 0) {
    low = Math.min(...parsed) - 14 * HOUR_MS;
    high = Math.max(...parsed) + 14 * HOUR_MS;
  } else {
    const prefixes = stamps.flatMap((stamp) => /^\d{4}-\d{2}-\d{2}/.test(stamp) ? [Date.parse(`${stamp.slice(0, 10)}T00:00:00.000Z`)] : []);
    if (prefixes.length === 0) return { from, to };
    low = Math.min(...prefixes) - 14 * HOUR_MS;
    high = Math.max(...prefixes) + DAY_MS + 14 * HOUR_MS;
  }
  return {
    from: new Date(Math.max(Date.parse(from), low)).toISOString(),
    to: new Date(Math.min(Date.parse(to), high)).toISOString(),
  };
}

function overlaps(block: BusyBlock, from: string, to: string): boolean {
  return Date.parse(block.startAt) < Date.parse(to) && Date.parse(block.endAt) > Date.parse(from);
}

/** The bounded, title-free calendar read used as the free-time capability probe. */
export async function GET(request: Request) {
  if (!resolveFreeSlots()) return jsonReason('feature_unavailable', 404);
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }

  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs - fromMs > 29 * DAY_MS) {
    return jsonReason('invalid_range', 400);
  }

  const storage = getStorage();
  const [feeds, calendarSources, manualWindow, manualCarry] = await Promise.all([
    storage.list<IcsFeedDocument>(userCol(user.uid, ICS_FEEDS), { limit: 5 }),
    storage.list<CalendarSource>(userCol(user.uid, CALENDAR_SOURCES)),
    storage.list<BusyBlock>(userCol(user.uid, BUSY_BLOCKS), {
      where: [['sourceKind', '==', 'manual'], ['startAt', '>=', new Date(fromMs - 14 * HOUR_MS).toISOString()], ['startAt', '<', new Date(toMs).toISOString()]],
      orderBy: { field: 'startAt', direction: 'asc' }, limit: STORAGE_LIMIT,
    }),
    storage.list<BusyBlock>(userCol(user.uid, BUSY_BLOCKS), {
      where: [['sourceKind', '==', 'manual'], ['endAt', '>', new Date(fromMs).toISOString()], ['endAt', '<=', new Date(fromMs + 40 * HOUR_MS).toISOString()]],
      orderBy: { field: 'endAt', direction: 'asc' }, limit: STORAGE_LIMIT,
    }),
  ]);
  const sourceById = new Map(calendarSources.map(({ data }) => [data.sourceId, data] as const));
  const icsRows = await Promise.all(feeds.map(({ data: feed }) => {
    const sourceId = `ics:${feed.feedId}`;
    return storage.list<BusyBlock>(userCol(user.uid, BUSY_BLOCKS), {
      where: [['sourceId', '==', sourceId], ['startAt', '<', new Date(toMs).toISOString()], ['endAt', '>', new Date(fromMs).toISOString()]],
      orderBy: { field: 'startAt', direction: 'asc' }, limit: STORAGE_LIMIT,
    });
  }));

  const now = Date.now();
  const sources = feeds.map(({ data: feed }) => {
    const sourceId = `ics:${feed.feedId}`;
    const source = sourceById.get(sourceId);
    const last = feed.lastFetchedAt;
    const status = !source ? 'uninitialized'
      : feed.status === 'paused' ? 'paused'
        : feed.status === 'error' ? 'error'
          : !last || !Number.isFinite(Date.parse(last)) ? 'uninitialized'
            : now - Date.parse(last) > STALE_MS ? 'stale' : 'ok';
    return {
      sourceId,
      kind: 'ics' as const,
      windowStart: source?.windowStart ?? null,
      windowEnd: source?.windowEnd ?? null,
      lastRefreshedAt: last ?? null,
      status,
    };
  });

  let complete = sources.every((source) => source.status === 'ok'
    && source.windowStart !== null && source.windowEnd !== null
    && Date.parse(source.windowStart) <= fromMs && Date.parse(source.windowEnd) >= toMs);
  let cutoff: string | null = null;
  if (manualCarry.length >= STORAGE_LIMIT) { complete = false; cutoff = new Date(fromMs).toISOString(); }

  const rows = new Map<string, StoredBusy>();
  const add = (row: StoredDoc<BusyBlock>) => {
    rows.set(row.id, { ...row.data, __docId: row.id });
  };
  for (const row of manualWindow) add(row);
  for (const row of manualCarry) if (Date.parse(row.data.startAt) < fromMs) add(row);
  icsRows.forEach((list) => list.forEach(add));

  const activeIcs = new Set(feeds.map(({ data }) => `ics:${data.feedId}`));
  const unknownRanges: Array<{ from: string; to: string }> = [];
  const valid = Array.from(rows.values()).flatMap((block) => {
    if (block.sourceKind === 'ics' && !activeIcs.has(block.sourceId)) return [];
    if (block.sourceKind === 'manual') {
      const unknown = unknownFor(block, new Date(fromMs).toISOString(), new Date(toMs).toISOString());
      if (unknown) { unknownRanges.push(unknown); return []; }
    }
    return overlaps(block, from, to) ? [block] : [];
  }).sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt)
    || String(left.__docId).localeCompare(String(right.__docId)));

  if (valid.length > MAX_READ_BLOCKS) {
    complete = false;
    const omitted = valid[MAX_READ_BLOCKS]!;
    cutoff = cutoff === null || Date.parse(omitted.startAt) < Date.parse(cutoff) ? omitted.startAt : cutoff;
  }
  const blocks = valid.slice(0, MAX_READ_BLOCKS).map(({ __docId: _id, blockId, sourceId, sourceKind, startAt, endAt, allDay }) => (
    { blockId, sourceId, sourceKind, startAt, endAt, allDay }
  ));
  return Response.json({ success: true, blocks, complete, cutoff, unknownRanges, sources });
}

/**
 * When somebody is busy, and nothing about what with (UC-3.2, #186).
 *
 * ── Why the consent check is here and not only on the phone ──────
 *
 * The app already refuses to sync until the Trust Center's calendar switch is
 * on, and that is the check that stops the bytes leaving the device — the one
 * that matters most, because data that never left cannot be held. This one
 * stops them being *kept*. A build with a bug, an old binary, or anything
 * holding a valid token can post a window; the server's answer to an account
 * that never said yes has to be a refusal rather than a row, or "we store your
 * busy time only if you asked us to" is a claim about a client rather than
 * about the service.
 *
 * `DELETE` deliberately does not check it. The person most likely to press
 * "Disconnect and delete" is the person who has just turned the switch off, and
 * a 403 there would strand their data on the server permanently.
 *
 * ── Why an extra key is a 400 ────────────────────────────────────
 *
 * `parseBusyUpload` refuses a block carrying `title`, `notes`, `location` or
 * anything else outside its allowlist, and this route reports that refusal
 * rather than storing the four fields it recognised. `expo-calendar` puts event
 * titles in the app's memory — the Flutter bridge never did — so the guarantee
 * that none of them reaches a server is now a property of code rather than of a
 * platform. A route that quietly dropped the extra key would keep the
 * guarantee and lose the ability to ever notice it had nearly been broken.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const trust = await readTrust(user.uid);
  if (trust?.calendarConsent !== true) {
    return Response.json(
      {
        success: false,
        error: 'calendar busy time is only stored once you turn the calendar on',
        reason: 'calendar_consent_required',
      },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  let upload;
  try {
    upload = parseBusyUpload(body);
  } catch (error) {
    if (error instanceof BusyUploadError) return mobileError(error.message, 400);
    throw error;
  }

  const blocks: BusyBlock[] = upload.blocks.map((block) => ({
    blockId: block.blockId,
    sourceId: upload.sourceId,
    sourceKind: upload.sourceKind,
    startAt: block.startAt,
    endAt: block.endAt,
    allDay: block.allDay,
  }));

  const now = new Date();
  await replaceBusyBlocks(user.uid, upload.sourceId, upload.window, blocks, {
    platform: upload.platform,
    now,
  });

  // The window and the time, and no count of anything the user could recognise.
  return Response.json({
    success: true,
    blocks: blocks.length,
    source: {
      sourceId: upload.sourceId,
      lastSyncedAt: now.toISOString(),
      windowStart: upload.window.startsAt,
      windowEnd: upload.window.endsAt,
    },
  });
}

/**
 * Disconnect and delete.
 *
 * The source is in the query string rather than a body for the reason the
 * device-calendar link route gives: a `DELETE` body is not reliably carried by
 * every intermediary, and this value decides what is removed. A request that
 * names no source is refused rather than treated as "all of them" — the wider
 * reading of a missing parameter is the one that cannot be undone.
 */
export async function DELETE(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const sourceId = new URL(request.url).searchParams.get('sourceId');
  if (sourceId === null || sourceId.trim() === '') {
    return mobileError('sourceId is required', 400);
  }

  try {
    const result = await deleteBusySource(user.uid, sourceId);
    return Response.json({ success: true, deleted: result.deleted });
  } catch (error) {
    if (error instanceof BusyUploadError) return mobileError(error.message, 400);
    throw error;
  }
}
