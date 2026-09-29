/**
 * Carries out `planWeeklyEvents` against the phone's calendar (weekly fixed
 * blocks, «ثابت أسبوعي»).
 *
 * The same bargain as the commitment sync's `reconcile`:
 *
 *   - nothing to do touches neither the OS nor storage beyond one read — no
 *     permission prompt, no permission read, for an account with the switch off;
 *   - a refused permission stops the pass (every later write would fail the
 *     same way), any other failure skips that block and the pass goes on;
 *   - a create writes first and records second, and when the record cannot be
 *     kept the events just written are taken back out again — an event with no
 *     link is one the next pass cannot see, so it would write a second one on
 *     every launch.
 *
 * The links are saved after every block rather than once at the end, so a
 * pass killed half-way leaves a record of exactly what it wrote.
 */
import { DeviceCalendarError, type DeviceCalendar } from '../calendar/deviceCalendar';
import type { CalendarWriteTarget } from '../../api/schemas/calendar';
import type { WeeklyBlock } from '../../api/schemas/weeklyBlocks';
import { planWeeklyEvents, type WeeklyEventDraft, type WeeklyEventLink, type WeeklyPlan } from './weeklyDeviceEvents';

export interface WeeklySyncPorts {
  calendar: DeviceCalendar;
  /** Null when storage could not be read: the pass then does nothing. */
  loadLinks(): Promise<WeeklyEventLink[] | null>;
  saveLinks(links: readonly WeeklyEventLink[]): Promise<boolean>;
  /** `calendar.writtenEventIds.v1`, so the busy read skips this app's own events. */
  rememberEvent(eventId: string): Promise<void>;
  forgetEvent(eventId: string): Promise<void>;
}

export interface WeeklySyncOutcome {
  created: number;
  updated: number;
  deleted: number;
  detached: number;
  skipped: number;
  permissionDenied: boolean;
  /** Storage refused a read or a write; the pass stopped rather than guess. */
  storageFailed: boolean;
}

export interface ReconcileWeeklyInput {
  blocks: readonly WeeklyBlock[] | undefined;
  writeTarget: CalendarWriteTarget;
  calendarId: string | null;
  multiDayRule: boolean;
  ports: WeeklySyncPorts;
}

function empty(): WeeklySyncOutcome {
  return { created: 0, updated: 0, deleted: 0, detached: 0, skipped: 0, permissionDenied: false, storageFailed: false };
}

class StorageRefused extends Error {}

export async function reconcileWeeklyEvents(input: ReconcileWeeklyInput): Promise<WeeklySyncOutcome> {
  const outcome = empty();
  const { ports } = input;
  const stored = await ports.loadLinks();
  if (stored === null) return { ...outcome, storageFailed: true };

  const plans = planWeeklyEvents({ ...input, links: stored });
  if (plans.length === 0) return outcome;

  if ((await ports.calendar.getAccess()) !== 'granted') {
    return { ...outcome, skipped: plans.length, permissionDenied: true };
  }

  const links = new Map(stored.map((link) => [link.blockId, link]));
  const save = async () => {
    if (!(await ports.saveLinks([...links.values()]))) throw new StorageRefused('weekly links not saved');
  };

  for (const plan of plans) {
    try {
      await apply(plan, links, save, ports, outcome);
    } catch (error) {
      if (error instanceof DeviceCalendarError && error.reason === 'permission_denied') {
        return { ...outcome, permissionDenied: true };
      }
      if (error instanceof StorageRefused) return { ...outcome, storageFailed: true };
      outcome.skipped += 1;
    }
  }
  return outcome;
}

/** Deletes what was just written, and does not let a second failure hide the first. */
async function takeBack(ids: readonly string[], ports: WeeklySyncPorts): Promise<void> {
  for (const id of ids) {
    try {
      await ports.calendar.deleteEvent(id);
      await ports.forgetEvent(id);
    } catch {
      // Best effort: the original failure is the one rethrown.
    }
  }
}

async function createAll(calendarId: string, drafts: readonly WeeklyEventDraft[], ports: WeeklySyncPorts): Promise<string[]> {
  const ids: string[] = [];
  try {
    for (const draft of drafts) {
      const id = await ports.calendar.createEvent(calendarId, draft);
      ids.push(id);
      await ports.rememberEvent(id);
    }
  } catch (error) {
    // Half a block (Monday written, Tuesday refused) is not the block; and an
    // id not in a link is an event no later pass can find.
    await takeBack(ids, ports);
    throw error;
  }
  return ids;
}

async function apply(
  plan: WeeklyPlan,
  links: Map<string, WeeklyEventLink>,
  save: () => Promise<void>,
  ports: WeeklySyncPorts,
  outcome: WeeklySyncOutcome,
): Promise<void> {
  switch (plan.kind) {
    case 'create': {
      const { calendarId } = plan;
      const ids = await createAll(calendarId, plan.drafts, ports);
      links.set(plan.blockId, { blockId: plan.blockId, calendarId, eventIds: ids, contentHash: plan.contentHash });
      try {
        await save();
      } catch (error) {
        links.delete(plan.blockId);
        await takeBack(ids, ports);
        throw error;
      }
      outcome.created += 1;
      return;
    }

    case 'update': {
      const { link } = plan;
      // The person deleted it in their Calendar app: that is an answer, and the
      // block is never written there again (the commitment sync's tombstone).
      const gone: string[] = [];
      for (const id of link.eventIds) if (!(await ports.calendar.eventExists(id))) gone.push(id);
      if (gone.length > 0) {
        for (const id of gone) await ports.forgetEvent(id);
        links.set(link.blockId, { ...link, detached: true });
        await save();
        outcome.detached += 1;
        return;
      }
      const ids = [...link.eventIds];
      const kept = Math.min(ids.length, plan.drafts.length);
      for (let index = 0; index < kept; index += 1) await ports.calendar.updateEvent(ids[index]!, plan.drafts[index]!);
      // Android writes one series per day: a block that gained a day gains a
      // series, one that lost a day loses one.
      const added = await createAll(link.calendarId, plan.drafts.slice(kept), ports);
      const surplus = ids.slice(kept);
      // Recorded before the surplus goes, so a delete that fails leaves an event
      // the link still names (and removes with the block), never an orphan.
      links.set(link.blockId, { blockId: link.blockId, calendarId: link.calendarId, eventIds: [...ids.slice(0, kept), ...added, ...surplus], contentHash: plan.contentHash });
      try {
        await save();
      } catch (error) {
        await takeBack(added, ports);
        throw error;
      }
      for (const id of surplus) {
        await ports.calendar.deleteEvent(id);
        await ports.forgetEvent(id);
      }
      if (surplus.length > 0) {
        links.set(link.blockId, { blockId: link.blockId, calendarId: link.calendarId, eventIds: [...ids.slice(0, kept), ...added], contentHash: plan.contentHash });
        await save();
      }
      outcome.updated += 1;
      return;
    }

    case 'delete': {
      for (const id of plan.link.eventIds) {
        await ports.calendar.deleteEvent(id);
        await ports.forgetEvent(id);
      }
      links.delete(plan.blockId);
      await save();
      outcome.deleted += 1;
      return;
    }

    case 'forget': {
      links.delete(plan.blockId);
      await save();
      return;
    }
  }
}

