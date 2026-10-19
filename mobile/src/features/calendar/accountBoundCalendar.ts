import { AccountChangedError } from '../../api/errors';
import { deviceCalendar, type DeviceCalendar } from './deviceCalendar';

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
}

export function accountBoundCalendar(stillCurrent: () => boolean): AccountBoundCalendar {
  const created = new Set<string>();
  const check = () => {
    if (!stillCurrent()) throw new AccountChangedError('the account changed during the calendar pass');
  };
  const calendar: DeviceCalendar = {
    ...deviceCalendar,
    createEvent: async (...args: Parameters<DeviceCalendar['createEvent']>) => {
      check();
      const eventId = await deviceCalendar.createEvent(...args);
      created.add(eventId);
      if (!stillCurrent()) {
        await deviceCalendar.deleteEvent(eventId).catch(() => undefined);
        created.delete(eventId);
        throw new AccountChangedError('the account changed during the calendar pass');
      }
      return eventId;
    },
    updateEvent: async (...args: Parameters<DeviceCalendar['updateEvent']>) => {
      check();
      return deviceCalendar.updateEvent(...args);
    },
    deleteEvent: async (...args: Parameters<DeviceCalendar['deleteEvent']>) => {
      check();
      return deviceCalendar.deleteEvent(...args);
    },
  };
  return {
    calendar,
    linked: (eventId) => { created.delete(eventId); },
    rollbackUnlinked: async () => {
      for (const eventId of [...created]) {
        await deviceCalendar.deleteEvent(eventId).catch(() => undefined);
        created.delete(eventId);
      }
    },
  };
}
