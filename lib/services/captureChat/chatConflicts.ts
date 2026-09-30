/**
 * What a proposed item's time lands on, while it is still only proposed
 * (owner request 2026-09-30: "the agent cannot describe what the commitment
 * is if there is a collision").
 *
 * The confirm already answers this for what it just saved
 * (`collisionsForCommitment`, #football-fixtures task 10). The chat has to say
 * it one step earlier — in the reply, and on the card — so the person can
 * decide before anything is kept. The rule is the confirm's own, not a copy:
 *
 *   saved commitments   `findCollisions` over the person's commitments: open,
 *   and followed        timed, a fixed event on at least one side, half-open
 *   matches             overlap. A followed match IS a commitment (the
 *                       football projection writes one); it is told apart by
 *                       the projection's own list (`listActiveFixtureCommitments`).
 *   weekly blocks       the block's materialized occurrences
 *                       (`listWeeklyBlockOccurrences`), titled by their block.
 *   calendar busy       Google, ICS and lecture busy time the server holds
 *                       (`listBusyBlocks`). Titleless by design, and never given
 *                       one: the reply says the calendar shows the person busy.
 *                       The phone's own calendar is not here — it lives only on
 *                       the phone, whose chip (`BusyConflictChip`) names it.
 *
 * Weekly and busy time is fixed on its side, so any overlap with the
 * candidate — measured by `candidateIntervalOf`, the confirm's own rule for how
 * long a candidate occupies — is a clash.
 *
 * Read once per chat message (`readPersonSchedule`), before the model is asked,
 * and used twice: for the days the model is shown, and for the items it
 * returned. Every read degrades to nothing on failure: a clash the chat could
 * not look up is not a reason to fail the person's message. Nothing here logs.
 */
import type { Commitment } from '../../../src/domain/stateMachine';
import type { CaptureItemConflictContract } from '../../../src/contracts/v1/captureContracts';
import type { WeeklyBlockOccurrenceContract } from '../../../src/contracts/v1/weeklyBlockContracts';
import type { TimeInterval } from '../../../src/contracts/v1/planningContracts';
import { instantFromLocal, localTimeSpecFor } from '../../../src/extraction/timeLexicon';
import { intervalsOverlap } from '../../planning/shared/time';
import { listBusyBlocks, type BusyBlock, type BusySourceKind } from '../../calendar/busyBlocks';
import { listWeeklyBlockOccurrences } from '../../weeklyBlocks/weeklyBlockService';
import { listActiveFixtureCommitments } from '../../football/projectFixtures';
import { getParticipantStateSnapshot } from '../mobile/participantState';
import { candidateIntervalOf, findCollisions, type CollisionCandidate } from '../timeCollision';

const DAY_MS = 86_400_000;
/** How far ahead the schedule is read: the busy store's own widest window. */
const SCHEDULE_AHEAD_DAYS = 400;
/** The most clashes one item carries: the card names each, and the reply the first. */
export const MAX_ITEM_CONFLICTS = 3;
/** The most entries of the person's own days the model is shown. */
export const MAX_SCHEDULE_ENTRIES = 24;
/** The most days of the person's schedule the model is shown. */
export const MAX_SCHEDULE_DAYS = 7;
/** The longest title the model is shown, of the person's saved things. */
const SCHEDULE_TITLE_MAX = 80;

/** Busy time the server holds and names as "your calendar": not the phone's own, and not a weekly block's. */
const SERVER_CALENDAR_KINDS: ReadonlySet<BusySourceKind> = new Set<BusySourceKind>(['google', 'ics', 'manual']);

/** What the person already has, as read once for one chat message. */
export interface PersonSchedule {
  readonly commitments: readonly Commitment[];
  readonly fixtureIds: ReadonlySet<string>;
  readonly weekly: readonly WeeklyBlockOccurrenceContract[];
  readonly busy: readonly BusyBlock[];
}

export const EMPTY_SCHEDULE: PersonSchedule = { commitments: [], fixtureIds: new Set(), weekly: [], busy: [] };

async function orNothing<T>(read: () => Promise<T>, nothing: T): Promise<T> {
  try {
    return await read();
  } catch {
    return nothing;
  }
}

/**
 * The person's commitments, followed matches, weekly occurrences and synced
 * busy time, from a day before `now` to `SCHEDULE_AHEAD_DAYS` after it. Each
 * source independently: one that cannot be read is simply empty.
 */
export async function readPersonSchedule(uid: string, now: Date): Promise<PersonSchedule> {
  const window: TimeInterval = {
    startsAt: new Date(now.getTime() - DAY_MS).toISOString(),
    endsAt: new Date(now.getTime() + SCHEDULE_AHEAD_DAYS * DAY_MS).toISOString(),
  };
  const [state, fixtures, weekly, busy] = await Promise.all([
    orNothing(() => getParticipantStateSnapshot(uid), null),
    orNothing(() => listActiveFixtureCommitments(uid), []),
    orNothing(() => listWeeklyBlockOccurrences(uid, window), []),
    orNothing(() => listBusyBlocks(uid, window), []),
  ]);
  return {
    commitments: state ? Object.values(state.commitments) : [],
    fixtureIds: new Set(fixtures.map((fixture) => fixture.commitmentId)),
    weekly,
    busy: busy.filter((block) => !block.allDay && SERVER_CALENDAR_KINDS.has(block.sourceKind)),
  };
}

/**
 * What a candidate lands on, soonest first: the confirm's `findCollisions`
 * over the commitments (a followed match marked `fixture`), then the weekly
 * occurrences and the calendar's busy time it overlaps. The same thing twice —
 * a block that is also a commitment, two busy rows for one meeting — is one.
 */
export function conflictsFor(
  candidate: CollisionCandidate,
  schedule: PersonSchedule,
  limit: number = MAX_ITEM_CONFLICTS,
): CaptureItemConflictContract[] {
  const interval = candidateIntervalOf(candidate);
  const found: CaptureItemConflictContract[] = [
    ...findCollisions(candidate, schedule.commitments).map((warning): CaptureItemConflictContract => ({
      title: warning.title,
      startsAt: warning.startsAt,
      endsAt: warning.endsAt,
      kind: schedule.fixtureIds.has(warning.commitmentId) ? 'fixture' : 'commitment',
    })),
    ...schedule.weekly
      .filter((occurrence) => intervalsOverlap(interval, { startsAt: occurrence.startAt, endsAt: occurrence.endAt }))
      .map((occurrence): CaptureItemConflictContract => ({
        title: occurrence.title,
        startsAt: occurrence.startAt,
        endsAt: occurrence.endAt,
        kind: 'weekly',
      })),
    ...schedule.busy
      .filter((block) => intervalsOverlap(interval, { startsAt: block.startAt, endsAt: block.endAt }))
      .map((block): CaptureItemConflictContract => ({ title: null, startsAt: block.startAt, endsAt: block.endAt, kind: 'calendar_busy' })),
  ];
  const seen = new Set<string>();
  return found
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .filter((conflict) => {
      const key = `${conflict.title ?? ''}|${conflict.startsAt}|${conflict.endsAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

/** Proposal items with their clashes, by item id; an item with none is left as it is. */
export function withItemConflicts<T extends { items: ReadonlyArray<{ itemId: string }> }>(
  proposal: T,
  candidates: ReadonlyMap<string, CollisionCandidate>,
  schedule: PersonSchedule,
): T {
  let changed = false;
  const items = proposal.items.map((item) => {
    const candidate = candidates.get(item.itemId);
    const conflicts = candidate ? conflictsFor(candidate, schedule) : [];
    if (conflicts.length === 0) return item;
    changed = true;
    return { ...item, conflicts };
  });
  return changed ? { ...proposal, items } : proposal;
}

/** One entry of the person's own days, as the model is shown it: their clock, their titles. */
export interface ScheduleEntryForPrompt {
  /** The person's own title; null for the calendar's busy time, which has none. */
  title: string | null;
  kind: CaptureItemConflictContract['kind'];
  /** `YYYY-MM-DD` on the person's clock. */
  date: string;
  /** `HH:MM` on the person's clock. */
  start: string;
  end: string;
}

/** A clash on the person's clock, for the model. */
export function conflictForPrompt(conflict: CaptureItemConflictContract, timezone: string): ScheduleEntryForPrompt | null {
  const start = localTimeSpecFor(new Date(conflict.startsAt), timezone);
  const end = localTimeSpecFor(new Date(conflict.endsAt), timezone);
  if (!start || !end) return null;
  const title = conflict.title === null
    ? null
    : conflict.title.length > SCHEDULE_TITLE_MAX ? `${conflict.title.slice(0, SCHEDULE_TITLE_MAX - 1)}…` : conflict.title;
  return { title, kind: conflict.kind, date: start.date, start: start.time, end: end.time };
}

/** `YYYY-MM-DD` plus one day. */
function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * What the person already has on the days this conversation is about — asked
 * as `conflictsFor` asks it of a candidate that is the whole day, so "what is
 * on Friday" and "what clashes with Friday at 6" are one rule. At most
 * `MAX_SCHEDULE_DAYS` days, `MAX_SCHEDULE_ENTRIES` entries.
 */
export function scheduleForPrompt(schedule: PersonSchedule, days: readonly string[], timezone: string): ScheduleEntryForPrompt[] {
  const entries: ScheduleEntryForPrompt[] = [];
  const seen = new Set<string>();
  for (const date of Array.from(new Set(days)).sort().slice(0, MAX_SCHEDULE_DAYS)) {
    const start = instantFromLocal(date, '00:00', timezone);
    const end = instantFromLocal(nextDate(date), '00:00', timezone);
    if (!start || !end) continue;
    const day: CollisionCandidate = { dueAt: start.toISOString(), endAt: end.toISOString(), kind: 'scheduled_event' };
    for (const conflict of conflictsFor(day, schedule, MAX_SCHEDULE_ENTRIES)) {
      const key = `${conflict.title ?? ''}|${conflict.startsAt}|${conflict.endsAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = conflictForPrompt(conflict, timezone);
      if (entry) entries.push(entry);
      if (entries.length >= MAX_SCHEDULE_ENTRIES) return entries;
    }
  }
  return entries;
}
