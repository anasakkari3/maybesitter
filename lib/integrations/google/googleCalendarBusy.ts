/**
 * Google Calendar busy time, through the same door the phone's calendar uses
 * (CL6a; UC-3.3 #187's source kind).
 *
 * ── Busy, never events ───────────────────────────────────────────
 *
 * The scope is `calendar.freebusy`: Google answers with intervals and nothing
 * else — no title, no attendee, no location — so the six-field guarantee in
 * `lib/calendar/busyBlocks.ts` holds by construction rather than by trimming.
 *
 * ── The same path, not a parallel one ────────────────────────────
 *
 * The intervals become `BusyBlock`s with `sourceKind: 'google'` and go through
 * `replaceBusyBlocks`, the one writer every calendar source uses. That is what
 * makes the planner (`readBusyBlocksForPlanning`), the replan tick (#611's
 * change rows, written in the same commit as each block) and account deletion
 * treat a Google block exactly as they treat a phone's: none of them can tell
 * which source a row came from, and none of them has to.
 *
 * ── Deduplicated against the phone ───────────────────────────────
 *
 * Most people who connect Google Calendar also have it on their phone, and the
 * phone already uploads the same meetings as `device` blocks. A Google interval
 * wholly covered by the account's timed device blocks is therefore not written:
 * it adds no busy time the planner does not already have, and on the Calendar
 * tab it would be the same meeting twice. An interval the phone covers only in
 * part is kept whole — freebusy merges back-to-back meetings into one interval,
 * and trimming it would invent a boundary no calendar has.
 *
 * ── All-day ──────────────────────────────────────────────────────
 *
 * Freebusy has no all-day flag. An interval of twenty-four hours or more is
 * recorded as `allDay`, which the planner does not block on — #186's decision
 * for the phone's all-day entries, applied to the only signal Google gives.
 */
import { busyBlockId, listBusyBlocks, replaceBusyBlocks, BUSY_BLOCK_UPLOAD_LIMIT, type BusyBlock } from '../../calendar/busyBlocks';
import { googleResourceFetch, refusalForResponse, GoogleConnectError } from './googleConnectService';
import { featuresGranted, GOOGLE_BUSY_SOURCE_ID } from './googleConfig';
import type { GoogleRuntime } from './googleRuntime';
import { CALENDAR_CHOICE, PROVIDER_CONNECTIONS, userDoc, userSubDoc } from '../../storage/paths';
import { connectionIdFor } from '../providers/production/storedConnectionStore';
import type { IntegrationConnectionRecord } from '../../../src/contracts/v1/integrationConnectionContracts';
import type { StorageTransaction } from '../../storage/storageAdapter';
import { M5A_CONTROLS_PATH, parseM5aControls, resolveM5aCapabilities } from '../../release/m5aControls';

export { GOOGLE_BUSY_SOURCE_ID };

export const GOOGLE_FREEBUSY_ENDPOINT = 'https://www.googleapis.com/calendar/v3/freeBusy';
/** The look-ahead the brief sets. The phone reads 28 days; Google's source is 14. */
export const GOOGLE_BUSY_LOOK_AHEAD_DAYS = 14;

const DAY_MS = 86_400_000;

export class GoogleCalendarConsentError extends Error {
  constructor() {
    super('calendar busy time is only stored once you turn the calendar on');
    this.name = 'GoogleCalendarConsentError';
  }
}

interface Interval {
  readonly startMs: number;
  readonly endMs: number;
}

/** Google's `calendars.primary.busy`, as intervals, or a refusal. Never the body. */
export function parseFreeBusy(body: unknown): Interval[] {
  const calendars = typeof body === 'object' && body !== null ? (body as { calendars?: unknown }).calendars : undefined;
  const primary = typeof calendars === 'object' && calendars !== null
    ? (calendars as Record<string, unknown>).primary
    : undefined;
  if (typeof primary !== 'object' || primary === null) throw new GoogleConnectError('google_unavailable');
  // A per-calendar error ("notFound", "internalError") is Google saying it could
  // not answer for this calendar. An empty list here would read as "free all
  // fortnight" and empty the phone of its busy time, so it is a refusal.
  if (Array.isArray((primary as { errors?: unknown }).errors) && ((primary as { errors: unknown[] }).errors.length > 0)) {
    throw new GoogleConnectError('google_unavailable');
  }
  const busy = (primary as { busy?: unknown }).busy;
  if (busy !== undefined && !Array.isArray(busy)) throw new GoogleConnectError('google_unavailable');
  const out: Interval[] = [];
  for (const entry of busy ?? []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const startMs = Date.parse(String((entry as { start?: unknown }).start ?? ''));
    const endMs = Date.parse(String((entry as { end?: unknown }).end ?? ''));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    out.push({ startMs, endMs });
  }
  return out;
}

/** True when the union of `cover` spans all of `interval`. */
export function coveredBy(interval: Interval, cover: readonly Interval[]): boolean {
  let reached = interval.startMs;
  const sorted = [...cover].sort((a, b) => a.startMs - b.startMs);
  for (const piece of sorted) {
    if (piece.endMs <= reached) continue;
    if (piece.startMs > reached) return false;
    reached = piece.endMs;
    if (reached >= interval.endMs) return true;
  }
  return reached >= interval.endMs;
}

/** Freebusy intervals as busy blocks, less what the phone already holds. */
export function toGoogleBusyBlocks(
  intervals: readonly Interval[],
  deviceTimed: readonly Interval[],
): BusyBlock[] {
  const seen = new Set<string>();
  const blocks: BusyBlock[] = [];
  for (const interval of intervals) {
    if (coveredBy(interval, deviceTimed)) continue;
    const startAt = new Date(interval.startMs).toISOString();
    const endAt = new Date(interval.endMs).toISOString();
    // Deterministic in the interval, so an unchanged calendar rewrites the same
    // rows and announces nothing to the replan tick.
    const blockId = busyBlockId(GOOGLE_BUSY_SOURCE_ID, `freebusy:${endAt}`, startAt);
    if (seen.has(blockId)) continue;
    seen.add(blockId);
    blocks.push({
      blockId,
      sourceId: GOOGLE_BUSY_SOURCE_ID,
      sourceKind: 'google',
      startAt,
      endAt,
      allDay: interval.endMs - interval.startMs >= DAY_MS,
    });
  }
  return blocks.slice(0, BUSY_BLOCK_UPLOAD_LIMIT);
}

function allGoogleBusyBlocks(
  intervals: readonly Interval[],
  deviceTimed: readonly Interval[] | null,
): BusyBlock[] {
  const seen = new Set<string>();
  const blocks: BusyBlock[] = [];
  for (const interval of intervals) {
    if (deviceTimed && coveredBy(interval, deviceTimed)) continue;
    const startAt = new Date(interval.startMs).toISOString();
    const endAt = new Date(interval.endMs).toISOString();
    const blockId = busyBlockId(GOOGLE_BUSY_SOURCE_ID, `freebusy:${endAt}`, startAt);
    if (seen.has(blockId)) continue;
    seen.add(blockId);
    blocks.push({ blockId, sourceId: GOOGLE_BUSY_SOURCE_ID, sourceKind: 'google', startAt, endAt,
      allDay: interval.endMs - interval.startMs >= DAY_MS });
  }
  return blocks;
}

interface CalendarAuthorityUser {
  readonly trust?: { readonly calendarConsent?: boolean } | null;
  readonly calendarEpoch?: number;
}

interface ChoiceGeneration {
  readonly v: 1;
  readonly generation: number;
  readonly state: 'purging' | 'active';
}

interface GoogleAuthority {
  readonly providerAccountId: string;
  readonly calendarEpoch: number;
  readonly choiceGeneration: number | null;
  readonly calendarControlEpoch: number | null;
}

function liveCalendarConnection(record: IntegrationConnectionRecord | null): record is IntegrationConnectionRecord {
  return Boolean(record
    && record.identity.provider === 'google'
    && record.identity.providerAccountId
    && record.state !== 'revoked'
    && record.state !== 'not_connected'
    && record.credentialRef
    && record.capabilities.includes('calendar_busy')
    && featuresGranted(record.grantedScopes).calendar);
}

async function googleAuthority(uid: string, runtime: GoogleRuntime): Promise<GoogleAuthority> {
  const [user, connection, choice, controlsValue] = await Promise.all([
    runtime.storage.get<CalendarAuthorityUser>(userDoc(uid)),
    runtime.storage.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
    runtime.storage.get<ChoiceGeneration>(userSubDoc(uid, CALENDAR_CHOICE, 'state')),
    runtime.storage.get(M5A_CONTROLS_PATH),
  ]);
  if (user?.trust?.calendarConsent !== true) throw new GoogleCalendarConsentError();
  if (!connection || connection.state === 'revoked' || connection.state === 'not_connected' || !connection.credentialRef) {
    throw new GoogleConnectError('google_not_connected');
  }
  if (connection.state === 'needs_reauth') throw new GoogleConnectError('google_reauth_required');
  if (!connection.capabilities.includes('calendar_busy') || !featuresGranted(connection.grantedScopes).calendar) {
    throw new GoogleConnectError('google_feature_not_granted');
  }
  if (!connection.identity.providerAccountId) throw new GoogleConnectError('google_not_connected');
  return {
    providerAccountId: connection.identity.providerAccountId!,
    calendarEpoch: user.calendarEpoch ?? 0,
    choiceGeneration: choice?.v === 1 ? choice.generation : null,
    calendarControlEpoch: parseM5aControls(controlsValue)?.calendar.epoch ?? null,
  };
}

async function guardGoogleAuthority(
  tx: StorageTransaction,
  uid: string,
  authority: GoogleAuthority,
): Promise<void> {
  const [user, connection, choice, controlsValue] = await Promise.all([
    tx.get<CalendarAuthorityUser>(userDoc(uid)),
    tx.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
    tx.get<ChoiceGeneration>(userSubDoc(uid, CALENDAR_CHOICE, 'state')),
    tx.get(M5A_CONTROLS_PATH),
  ]);
  const choiceGeneration = choice?.v === 1 ? choice.generation : null;
  if (user?.trust?.calendarConsent !== true
    || (user.calendarEpoch ?? 0) !== authority.calendarEpoch
    || !liveCalendarConnection(connection)
    || connection.identity.providerAccountId !== authority.providerAccountId
    || choiceGeneration !== authority.choiceGeneration
    || (parseM5aControls(controlsValue)?.calendar.epoch ?? null) !== authority.calendarControlEpoch) {
    throw new GoogleConnectError('google_not_connected');
  }
}

export interface GoogleCalendarSyncResult {
  readonly blocks: number;
  readonly source: {
    readonly sourceId: string;
    readonly lastSyncedAt: string;
    readonly windowStart: string;
    readonly windowEnd: string;
  };
}

/**
 * Reads the next fourteen days of busy time and stores it as the Google source.
 *
 * Refused without the Trust Center's calendar consent, exactly as the phone's
 * upload is: "we keep your busy time only if you asked us to" is a property of
 * the service, whichever calendar it came from.
 */
export async function syncGoogleCalendarBusy(uid: string, runtime: GoogleRuntime): Promise<GoogleCalendarSyncResult> {
  const authority = await googleAuthority(uid, runtime);
  const choice = await runtime.storage.get<ChoiceGeneration>(userSubDoc(uid, CALENDAR_CHOICE, 'state'));
  const capabilities = await resolveM5aCapabilities({
    storage: runtime.storage,
    env: runtime.env as unknown as Record<string, string | undefined>,
  });
  const m5FullSource = Boolean(choice) || capabilities.calendarChoice || capabilities.emailSources;

  const now = runtime.now();
  const windowStart = now.toISOString();
  const windowEnd = new Date(now.getTime() + GOOGLE_BUSY_LOOK_AHEAD_DAYS * DAY_MS).toISOString();

  const response = await googleResourceFetch(uid, 'calendar', runtime, GOOGLE_FREEBUSY_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({ timeMin: windowStart, timeMax: windowEnd, items: [{ id: 'primary' }] }),
  });
  if (!response.ok) throw refusalForResponse(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GoogleConnectError('google_unavailable');
  }
  const intervals = parseFreeBusy(body);

  const window = { startsAt: windowStart, endsAt: windowEnd };
  const device = (await listBusyBlocks(uid, window, { storage: runtime.storage }))
    .filter((block) => block.sourceKind === 'device' && !block.allDay)
    .map((block) => ({ startMs: Date.parse(block.startAt), endMs: Date.parse(block.endAt) }));
  const allBlocks = allGoogleBusyBlocks(intervals, m5FullSource ? null : device);
  const firstOmitted = allBlocks[BUSY_BLOCK_UPLOAD_LIMIT];
  const honestWindowEnd = firstOmitted?.startAt ?? windowEnd;
  const blocks = allBlocks
    .filter((block) => Date.parse(block.startAt) < Date.parse(honestWindowEnd))
    .slice(0, BUSY_BLOCK_UPLOAD_LIMIT);

  await replaceBusyBlocks(uid, GOOGLE_BUSY_SOURCE_ID, { ...window, endsAt: honestWindowEnd }, blocks, {
    storage: runtime.storage,
    platform: null,
    now,
    ...(m5FullSource ? {
      transactionGuard: async (tx: StorageTransaction) => { await guardGoogleAuthority(tx, uid, authority); },
      sourceMetadata: (fence: { readonly generation: number } | null) => ({
        coverageStatus: 'settled' as const,
        m5Certificate: {
          v: 1 as const,
          choiceGeneration: authority.choiceGeneration,
          providerAccountId: authority.providerAccountId,
          fenceGeneration: fence?.generation ?? 0,
          refreshedAt: now.toISOString(),
        },
      }),
    } : {}),
  });
  return {
    blocks: blocks.length,
    source: { sourceId: GOOGLE_BUSY_SOURCE_ID, lastSyncedAt: now.toISOString(), windowStart, windowEnd: honestWindowEnd },
  };
}

/** The Google blocks in a window, for the Calendar tab. Six fields each, no more. */
export async function listGoogleBusyBlocks(
  uid: string,
  window: { readonly startsAt: string; readonly endsAt: string },
  runtime: GoogleRuntime,
): Promise<BusyBlock[]> {
  return (await listBusyBlocks(uid, window, { storage: runtime.storage }))
    .filter((block) => block.sourceKind === 'google');
}
