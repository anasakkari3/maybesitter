/**
 * Weekly fixed blocks («ثابت أسبوعي») in the phone's own calendar — the plan.
 *
 * Owner requirement: when «حطّ التزاماتي بتقويمي» is on, each active block is
 * ONE recurring event in the chosen calendar (weekly on its days, from
 * `startsOn`, at its hours in its own zone), updated when the block changes
 * and removed when it is paused or deleted.
 *
 * ── Pure, like the commitment sync's `decide` ─────────────────────
 *
 * `planWeeklyEvents` takes no clock, no storage and no native module. The
 * blocks come from the account, the links (which device events this phone
 * wrote for which block) from this phone's storage, and what comes out is a
 * list of create / update / delete / forget. `weeklyEventSync.ts` carries it
 * out through `DeviceCalendar`.
 *
 * ── One event per block — where the platform can say so ───────────
 *
 * iOS writes `BYDAY`, so a Sunday-to-Thursday block is one event. Android's
 * expo-calendar writes `FREQ=WEEKLY` only (see `weeklyRuleCarriesDays`), and a
 * series there repeats on its first day's weekday alone; writing one series
 * would silently drop four of five days. So on Android a block is one series
 * per weekday — still exactly one event for «كل سبت», the common case — and
 * the link holds every id.
 *
 * ── The rules, strongest first ─────────────────────────────────────
 *
 *   - a list that has not loaded is not an empty list: nothing is planned,
 *     because "no blocks" would delete every event this phone wrote;
 *   - taking back is not writing: a paused or deleted block's event is removed
 *     whether or not the switch is still on (the commitment sync's rule);
 *   - an event the person deleted by hand is never written again (`detached`),
 *     and its link is forgotten only with the block;
 *   - with the target off, or pointed at Google, nothing new is written and no
 *     change is chased;
 *   - no calendar chosen, nothing is written (`needsWeeklyCalendar` lets the
 *     sync adopt the only one there is, as the commitment sync does).
 */
import type { WeeklyBlock, WeeklyBlockDeviceEvent } from '../../api/schemas/weeklyBlocks';
import type { CalendarWriteTarget } from '../../api/schemas/calendar';
import type { CalendarEventDraft } from '../calendar/deviceCalendar';
import type { DeviceBusyBlock } from '../calendar/busyBlocks';
import { contentHashOf, EVENT_NOTES } from '../calendar/eventDraft';
import { instantForWallClock } from '../../lib/time/zoneOffset';

/** Which device events this phone wrote for one block. Device facts, never on the account. */
export interface WeeklyEventLink {
  blockId: string;
  calendarId: string;
  /** One on iOS; one per weekday on Android. */
  eventIds: string[];
  /** `weeklyHash` of what was written. */
  contentHash: string;
  /** The person deleted the event in their Calendar app: never write it again. */
  detached?: boolean;
}

export interface WeeklyEventDraft extends CalendarEventDraft {
  recurrence: { weekdays: number[] };
}

export type WeeklyPlan =
  | { kind: 'create'; blockId: string; calendarId: string; drafts: WeeklyEventDraft[]; contentHash: string }
  | { kind: 'update'; blockId: string; link: WeeklyEventLink; drafts: WeeklyEventDraft[]; contentHash: string }
  | { kind: 'delete'; blockId: string; link: WeeklyEventLink }
  | { kind: 'forget'; blockId: string };

/** A screen link (`links.ts`), not a per-block one: it opens the list of blocks. */
export const WEEKLY_EVENT_URL = 'maybesitter://weeklyBlocks';

const DAY_MS = 86_400_000;

function weekdayOf(dayKey: string): number {
  return new Date(`${dayKey}T12:00:00.000Z`).getUTCDay();
}

function shift(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The first day on or after `from` whose weekday is one of `weekdays`. */
function firstOn(from: string, weekdays: readonly number[]): string {
  for (let offset = 0; offset < 7; offset += 1) {
    const day = shift(from, offset);
    if (weekdays.includes(weekdayOf(day))) return day;
  }
  return from;
}

function at(dayKey: string, clock: string, timeZone: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number) as [number, number, number];
  const [hour, minute] = clock.split(':').map(Number) as [number, number];
  return instantForWallClock({ year, month, day, hour, minute }, timeZone);
}

function sortedDays(weekdays: readonly number[]): number[] {
  return [...new Set(weekdays)].sort((a, b) => a - b);
}

/**
 * The event(s) for a block's `deviceEvent`: one series carrying every day when
 * `multiDayRule`, otherwise one per day, each starting on its first occurrence
 * on or after `startsOn`, at `start`–`end` on the block's own clock — so a
 * clock change moves the instant and never the hour.
 */
export function weeklyDrafts(_blockId: string, event: WeeklyBlockDeviceEvent, multiDayRule: boolean): WeeklyEventDraft[] {
  const days = sortedDays(event.weekdays);
  const groups = multiDayRule ? [days] : days.map((day) => [day]);
  return groups.map((group) => {
    const first = firstOn(event.startsOn, group);
    return {
      title: event.title,
      notes: EVENT_NOTES,
      startDate: at(first, event.start, event.timezone),
      endDate: at(first, event.end, event.timezone),
      allDay: false,
      timeZone: event.timezone,
      // Opens «الثابت الأسبوعي» from the event (iOS shows the link).
      url: WEEKLY_EVENT_URL,
      recurrence: { weekdays: group },
    };
  });
}

/**
 * A digest of what the calendar shows for a block — not of `updatedAt`, so a
 * change the calendar cannot see is not a rewrite (on a shared calendar every
 * rewrite is a notification for everybody), and every change it can see is.
 */
export function weeklyHash(event: WeeklyBlockDeviceEvent, multiDayRule: boolean): string {
  return contentHashOf([
    'weekly',
    event.title,
    sortedDays(event.weekdays).join(','),
    event.start,
    event.end,
    event.timezone,
    event.startsOn,
    multiDayRule ? 'byday' : 'per-day',
    EVENT_NOTES,
  ]);
}

export interface PlanWeeklyInput {
  /** `undefined` while the list has not loaded (or failed): nothing is planned. */
  blocks: readonly WeeklyBlock[] | undefined;
  links: readonly WeeklyEventLink[];
  writeTarget: CalendarWriteTarget;
  calendarId: string | null;
  multiDayRule: boolean;
}

export function planWeeklyEvents(input: PlanWeeklyInput): WeeklyPlan[] {
  if (input.blocks === undefined) return [];
  const byId = new Map(input.blocks.map((block) => [block.id, block]));
  const linked = new Map(input.links.map((link) => [link.blockId, link]));
  const plans: WeeklyPlan[] = [];

  // Links first: taking back what was written does not depend on the switch.
  for (const link of input.links) {
    const block = byId.get(link.blockId);
    if (link.detached) {
      if (!block) plans.push({ kind: 'forget', blockId: link.blockId });
      continue;
    }
    if (!block || block.status !== 'active' || block.deviceEvent === null) {
      plans.push({ kind: 'delete', blockId: link.blockId, link });
      continue;
    }
    if (input.writeTarget !== 'device') continue;
    const contentHash = weeklyHash(block.deviceEvent, input.multiDayRule);
    if (contentHash === link.contentHash) continue;
    plans.push({ kind: 'update', blockId: block.id, link, drafts: weeklyDrafts(block.id, block.deviceEvent, input.multiDayRule), contentHash });
  }

  if (input.writeTarget !== 'device' || input.calendarId === null) return plans;
  for (const block of input.blocks) {
    if (linked.has(block.id) || block.status !== 'active' || block.deviceEvent === null) continue;
    plans.push({
      kind: 'create',
      blockId: block.id,
      calendarId: input.calendarId,
      drafts: weeklyDrafts(block.id, block.deviceEvent, input.multiDayRule),
      contentHash: weeklyHash(block.deviceEvent, input.multiDayRule),
    });
  }
  return plans;
}

/** Whether a calendar choice is all that stands between an active block and its event. */
export function needsWeeklyCalendar(input: Omit<PlanWeeklyInput, 'calendarId'>): boolean {
  const without = planWeeklyEvents({ ...input, calendarId: null }).filter((plan) => plan.kind === 'create').length;
  const withOne = planWeeklyEvents({ ...input, calendarId: 'probe' }).filter((plan) => plan.kind === 'create').length;
  return withOne > without;
}

/**
 * The phone's busy time with the weekly blocks' own entries taken out, for
 * the Calendar tab and Today, which draw the block itself (its title and
 * hours) from `/weekly-blocks/occurrences`.
 *
 * Two ways a busy block is the same thing drawn twice: its id is one this
 * phone wrote for a block (`ownEventIds`, from the links); or it is exactly an
 * occurrence's interval — the event another phone wrote, or the one that came
 * back through Google — which carries no id this phone knows. An overlap that
 * is not the same interval is a different appointment and stays.
 */
export function hideWeeklyDuplicates(
  busy: readonly DeviceBusyBlock[],
  ownEventIds: ReadonlySet<string>,
  occurrences: readonly { startAt: string; endAt: string }[],
): DeviceBusyBlock[] {
  const intervals = new Set(occurrences.map((occurrence) => `${Date.parse(occurrence.startAt)}/${Date.parse(occurrence.endAt)}`));
  return busy.filter((block) => !ownEventIds.has(block.nativeId)
    && !intervals.has(`${Date.parse(block.startAt)}/${Date.parse(block.endAt)}`));
}
