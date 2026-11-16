/**
 * Manual busy time writer for syllabus lecture sessions (UC-3.7, #191 Step 7).
 *
 * Accepting a syllabus's recurring sessions creates a manual busy source
 * `users/{uid}/calendarSources/manual-{proposalId}` via `replaceBusyBlocks` (UC-3.2, #186),
 * expanded for 16 weeks.
 *
 * ── Invariants ──────────────────────────────────────────────────────────
 *
 *  - Busy blocks, NOT commitments: consistent with UC-3.4 (#188). A recurring lecture
 *    is time a person is occupied, not thirty-two tasks to complete.
 *  - Deterministic block IDs: hashed via `busyBlockId` using the native session
 *    signature and calculated start time.
 *  - Overwrite/replace semantics: re-accepting updates the blocks of that source cleanly.
 */

import { getStorage, type StorageAdapter } from '../storage';
import { CALENDAR_CHOICE, CALENDAR_SOURCES, userCol, userDoc, userSubDoc } from '../storage/paths';
import { assertLiveAccount } from '../account/accountLiveness';
import {
  BusyUploadError,
  busyBlockId,
  deleteBusySource,
  replaceBusyBlocks,
  type BusyBlock,
  type CalendarSource,
} from './busyBlocks';
import {
  addLocalDays,
  dateFromOptionalIso,
  localDayKey,
  localMidnightOf,
  normalizeTimezone,
} from '../services/mobile/time';
import {
  instantFromResolution,
  resolveLocalTime,
  toEpochMs,
  weekdayAt,
} from '../planning/shared/time';
import type { TimeInterval } from '../../src/contracts/v1/planningContracts';
import type { ShareRecurringSession } from '../services/share/shareTypes';

/** Default number of weeks to expand a recurring lecture session for. */
export const DEFAULT_LECTURE_EXPANSION_WEEKS = 16;

/** The source ID for a manual proposal-derived calendar source. */
export function manualBusySourceId(proposalId: string): string {
  return `manual-${proposalId}`;
}

export interface ExpandLectureSessionsOptions {
  readonly timezone: string;
  readonly referenceTime?: string | Date;
  readonly weeks?: number;
}

export interface ExpandedLectureBlocksResult {
  readonly sourceId: string;
  readonly window: TimeInterval;
  readonly blocks: readonly BusyBlock[];
}

/**
 * Expands recurring sessions into individual BusyBlock items across a given number of weeks.
 */
export function expandLectureSessionsToBusyBlocks(
  proposalId: string,
  sessions: readonly ShareRecurringSession[],
  options: ExpandLectureSessionsOptions,
): ExpandedLectureBlocksResult {
  return expandWeeklySessionsToBusyBlocks(manualBusySourceId(proposalId), 'manual', sessions, options);
}

/**
 * The expansion itself, for any source that states `{weekday, start, end}`
 * sessions: accepted lecture sessions (`manual-*`) and weekly fixed blocks
 * (`weekly-*`, lib/weeklyBlocks). One implementation, so a lecture and a
 * Saturday shift land on the local clock by the same DST rule.
 */
export function expandWeeklySessionsToBusyBlocks(
  sourceId: string,
  sourceKind: 'manual' | 'weekly',
  sessions: readonly Pick<ShareRecurringSession, 'weekday' | 'start' | 'end'>[],
  options: ExpandLectureSessionsOptions,
): ExpandedLectureBlocksResult {
  const zone = normalizeTimezone(options.timezone);
  const weeks = Math.max(1, Math.min(options.weeks ?? DEFAULT_LECTURE_EXPANSION_WEEKS, 52));

  const refDate = dateFromOptionalIso(options.referenceTime, new Date(), 'referenceTime');
  const todayKey = localDayKey(refDate, zone);
  const todayMidnight = localMidnightOf(todayKey, zone);
  const currentWeekday = weekdayAt(toEpochMs(todayMidnight), zone);

  const windowStart = todayMidnight;
  // Window covers the full expansion weeks + 1 day padding
  const windowEnd = addLocalDays(todayMidnight, weeks * 7 + 1, zone);
  const window: TimeInterval = { startsAt: windowStart, endsAt: windowEnd };

  const blocks: BusyBlock[] = [];

  for (const session of sessions) {
    if (!Number.isInteger(session.weekday) || session.weekday < 0 || session.weekday > 6) {
      continue;
    }
    const [startH, startM] = session.start.split(':').map((s) => Number(s));
    const [endH, endM] = session.end.split(':').map((s) => Number(s));
    if (
      !Number.isInteger(startH) || !Number.isInteger(startM)
      || !Number.isInteger(endH) || !Number.isInteger(endM)
      || startH < 0 || startH > 23 || startM < 0 || startM > 59
      || endH < 0 || endH > 23 || endM < 0 || endM > 59
      || endH * 60 + endM <= startH * 60 + startM
    ) {
      continue;
    }

    // Days until the first occurrence of this weekday on or after the reference day
    const daysUntilFirst = (session.weekday - currentWeekday + 7) % 7;
    const firstSessionDay = addLocalDays(todayMidnight, daysUntilFirst, zone);

    for (let w = 0; w < weeks; w++) {
      const occDay = addLocalDays(firstSessionDay, w * 7, zone);
      const occDayKey = localDayKey(occDay, zone);
      const [year, month, day] = occDayKey.split('-').map(Number);

      const startRes = resolveLocalTime({ year, month, day, hour: startH, minute: startM }, zone);
      const startAt = instantFromResolution(startRes, 'earliest')
        ?? `${occDayKey}T${session.start}:00.000Z`;

      const endRes = resolveLocalTime({ year, month, day, hour: endH, minute: endM }, zone);
      const endAt = instantFromResolution(endRes, 'earliest')
        ?? `${occDayKey}T${session.end}:00.000Z`;

      const nativeEventId = `${session.weekday}-${session.start}-${session.end}`;
      const blockId = busyBlockId(sourceId, nativeEventId, startAt);

      blocks.push({
        blockId,
        sourceId,
        sourceKind,
        startAt,
        endAt,
        allDay: false,
      });
    }
  }

  return { sourceId, window, blocks };
}

export interface AcceptLectureSessionsOptions extends ExpandLectureSessionsOptions {
  readonly storage?: StorageAdapter;
  readonly now?: Date;
}

function validSessionClock(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validSessionRange(session: Pick<ShareRecurringSession, 'start' | 'end'>): boolean {
  if (!validSessionClock(session.start) || !validSessionClock(session.end)) return false;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  return minutes(session.end) > minutes(session.start);
}

/**
 * Persists accepted lecture sessions as busy blocks using replaceBusyBlocks.
 * Never creates commitments.
 */
export async function acceptLectureSessionsAsBusyBlocks(
  uid: string,
  proposalId: string,
  sessions: readonly ShareRecurringSession[],
  options: AcceptLectureSessionsOptions,
): Promise<{ sourceId: string; written: number; removed: number; window: TimeInterval }> {
  if (sessions.some((session) => !validSessionRange(session))) {
    throw new BusyUploadError('session times must be exact HH:MM values with end after start');
  }
  if (sessions.length > MANUAL_SESSION_LIMIT) throw new ManualBusyLimitError('too_many_sessions');
  const { sourceId, window, blocks } = expandLectureSessionsToBusyBlocks(proposalId, sessions, options);

  const storage = options.storage ?? getStorage();
  await reserveManualSource(storage, uid, sourceId, options.now ?? new Date());
  let outcome: { written: number; removed: number };
  try {
    outcome = await replaceBusyBlocks(uid, sourceId, window, blocks, {
      storage,
      platform: null,
      now: options.now,
    });
  } finally {
    // Written, it is counted as stored; not written, the place is given back.
    await releaseManualSource(storage, uid, sourceId).catch(() => undefined);
  }

  return {
    sourceId,
    written: outcome.written,
    removed: outcome.removed,
    window,
  };
}

/* ── Limits and removal (QA audit CA10.4 / CXA10.3, #749) ─────────────── */

/** Sessions one acceptance may carry: a syllabus's week, with room to spare. */
export const MANUAL_SESSION_LIMIT = 20;
/** Manual sources one account may hold at once (each is 16 weeks of blocks). */
export const MANUAL_SOURCE_LIMIT = 10;

export class ManualBusyLimitError extends Error {
  constructor(readonly reason: 'too_many_sessions' | 'manual_busy_limit') {
    super(reason);
    this.name = 'ManualBusyLimitError';
  }
}

/**
 * The count is taken from what is stored, not kept beside it (review of wave
 * B8): a counter drifted whenever a source went another way (`DELETE
 * /calendar/busy`), a delete raced a re-accept, or a create died between its
 * reservation and its write. The limit is "manual sources stored, plus creates
 * in flight". In flight are the reservations in one manifest document, so two
 * concurrent creates read and write the same document and only one commits;
 * a reservation older than PENDING_TTL_MS whose source never appeared is a
 * create that died, and holds nothing. The manifest is written only under a
 * live account (#772): a deletion sweep is never followed by a new row.
 */
const PENDING_TTL_MS = 5 * 60_000;

interface ManualBusyManifest {
  /** sourceId → when its create reserved the place. */
  readonly pending: Readonly<Record<string, string>>;
}

function manifestPath(uid: string): string {
  return userSubDoc(uid, CALENDAR_CHOICE, 'manualBusy');
}

async function reserveManualSource(storage: StorageAdapter, uid: string, sourceId: string, now: Date): Promise<void> {
  await storage.runTransaction(async (tx) => {
    const [user, manifest, rows] = await Promise.all([
      tx.get(userDoc(uid)),
      tx.get<Partial<ManualBusyManifest>>(manifestPath(uid)),
      tx.list<CalendarSource>(userCol(uid, CALENDAR_SOURCES), { where: [['kind', '==', 'manual']] }),
    ]);
    assertLiveAccount(user);
    const stored = new Set(rows.map((row) => row.data.sourceId));
    const nowMs = now.getTime();
    const pending: Record<string, string> = {};
    for (const [id, at] of Object.entries(manifest?.pending ?? {})) {
      if (!stored.has(id) && nowMs - Date.parse(at) < PENDING_TTL_MS) pending[id] = at;
    }
    const held = new Set([...Array.from(stored), ...Object.keys(pending)]);
    if (!held.has(sourceId) && held.size >= MANUAL_SOURCE_LIMIT) throw new ManualBusyLimitError('manual_busy_limit');
    if (!stored.has(sourceId)) pending[sourceId] = now.toISOString();
    tx.set<ManualBusyManifest>(manifestPath(uid), { pending });
  });
}

/** The create is over, written or not: its reservation is no longer needed. */
async function releaseManualSource(storage: StorageAdapter, uid: string, sourceId: string): Promise<void> {
  await storage.runTransaction(async (tx) => {
    const manifest = await tx.get<Partial<ManualBusyManifest>>(manifestPath(uid));
    if (!manifest?.pending || !(sourceId in manifest.pending)) return;
    const { [sourceId]: _released, ...rest } = manifest.pending;
    tx.set<ManualBusyManifest>(manifestPath(uid), { pending: rest });
  });
}

/** Removes a manual source's blocks and record, and gives its place back. */
export async function deleteManualBusySource(
  uid: string,
  sourceId: string,
  deps: { readonly storage?: StorageAdapter; readonly now?: Date } = {},
): Promise<{ deleted: number }> {
  const storage = deps.storage ?? getStorage();
  const result = await deleteBusySource(uid, sourceId, { storage, now: deps.now });
  await releaseManualSource(storage, uid, sourceId);
  return result;
}

export interface ManualBusySourceView {
  readonly sourceId: string;
  readonly proposalId: string;
  readonly addedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
}

/** What the person added by hand, for the app to show and remove. Oldest first. */
export async function listManualBusySources(
  uid: string,
  deps: { readonly storage?: StorageAdapter } = {},
): Promise<ManualBusySourceView[]> {
  const storage = deps.storage ?? getStorage();
  const rows = await storage.list<CalendarSource>(userCol(uid, CALENDAR_SOURCES), { where: [['kind', '==', 'manual']] });
  return rows
    .map((row) => row.data)
    .filter((source) => source.sourceId.startsWith('manual-'))
    .map((source) => ({
      sourceId: source.sourceId,
      proposalId: source.sourceId.slice('manual-'.length),
      addedAt: source.lastSyncedAt,
      windowStart: source.windowStart,
      windowEnd: source.windowEnd,
    }))
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.sourceId.localeCompare(b.sourceId));
}
