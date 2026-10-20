import { AccountChangedError } from '../../api/errors';
import { deviceCalendar, type DeviceCalendar } from './deviceCalendar';
import { loadUnlinkedCreated, noteUnlinkedCreated, settleUnlinkedCreated } from '../../lib/deviceSettings/calendarDevice';

/**
 * The phone's calendar, bound to the account a write pass began for
 * (M5A-R21-001).
 *
 * Every create, update and delete asks `stillCurrent` first and throws
 * `AccountChangedError` once the account has changed, so a pass never writes
 * account A's events after B signed in. Events this pass created are tracked
 * until they are linked; `rollbackUnlinked` takes back exactly those, through
 * the unguarded calendar, when the pass ends under another account.
 */
export interface AccountBoundCalendar {
  calendar: DeviceCalendar;
  /** The pass saved its link for this event: it is no longer this pass's to take back. */
  linked(eventId: string): void;
  /** Removes events this pass created and never linked. Called when the account changed. */
  rollbackUnlinked(): Promise<void>;
  /**
   * Retries the removal of events an earlier pass of this account created and
   * could not take back (M5A-R8-002), except those a stored link names.
   */
  recoverUnlinked(linkedEventIds: ReadonlySet<string>): Promise<void>;
}

export function accountBoundCalendar(stillCurrent: () => boolean, owner?: string): AccountBoundCalendar {
  const created = new Set<string>();
  // A failed delete keeps the event recorded and in the set (M5A-R8-002).
  const takeBack = async (eventId: string): Promise<void> => {
    try {
      await deviceCalendar.deleteEvent(eventId);
    } catch {
      return;
    }
    created.delete(eventId);
    if (owner) await settleUnlinkedCreated(owner, eventId);
  };
  const check = () => {
    if (!stillCurrent()) throw new AccountChangedError('the account changed during the calendar pass');
  };
  const calendar: DeviceCalendar = {
    ...deviceCalendar,
    createEvent: async (...args: Parameters<DeviceCalendar['createEvent']>) => {
      check();
      const eventId = await deviceCalendar.createEvent(...args);
      created.add(eventId);
      if (owner) {
        try {
          await noteUnlinkedCreated(owner, eventId);
        } catch (error) {
          // Unrecorded, it could not be retried later: taken back out now.
          await deviceCalendar.deleteEvent(eventId).then(() => { created.delete(eventId); }, () => undefined);
          throw error;
        }
      }
      if (!stillCurrent()) {
        await takeBack(eventId);
        throw new AccountChangedError('the account changed during the calendar pass');
      }
      return eventId;
    },
    // Asked again after the native call (M5A-R6-002): nothing that follows it
    // in the pass runs for an account that is no longer signed in.
    updateEvent: async (...args: Parameters<DeviceCalendar['updateEvent']>) => {
      check();
      await deviceCalendar.updateEvent(...args);
      check();
    },
    deleteEvent: async (...args: Parameters<DeviceCalendar['deleteEvent']>) => {
      check();
      await deviceCalendar.deleteEvent(...args);
      check();
    },
  };
  return {
    calendar,
    linked: (eventId) => {
      created.delete(eventId);
      if (owner) void settleUnlinkedCreated(owner, eventId);
    },
    rollbackUnlinked: async () => {
      for (const eventId of [...created]) await takeBack(eventId);
    },
    recoverUnlinked: async (linkedEventIds) => {
      if (!owner || !stillCurrent()) return;
      let recorded: string[];
      try {
        recorded = await loadUnlinkedCreated(owner);
      } catch {
        return;
      }
      for (const eventId of recorded) {
        if (!stillCurrent()) return;
        if (created.has(eventId)) continue;
        if (linkedEventIds.has(eventId)) {
          await settleUnlinkedCreated(owner, eventId);
          continue;
        }
        try {
          await deviceCalendar.deleteEvent(eventId);
        } catch {
          continue;
        }
        await settleUnlinkedCreated(owner, eventId);
      }
    },
  };
}
