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

import { type StorageAdapter } from '../storage';
import {
  busyBlockId,
  replaceBusyBlocks,
  type BusyBlock,
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
  const sourceId = manualBusySourceId(proposalId);
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
        sourceKind: 'manual',
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
  const { sourceId, window, blocks } = expandLectureSessionsToBusyBlocks(proposalId, sessions, options);

  const outcome = await replaceBusyBlocks(uid, sourceId, window, blocks, {
    storage: options.storage,
    platform: null,
    now: options.now,
  });

  return {
    sourceId,
    written: outcome.written,
    removed: outcome.removed,
    window,
  };
}
