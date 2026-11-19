/**
 * What a client may send to `PUT /api/mobile/commitments/{id}/device-calendar-link`,
 * and the one function that decides whether it is acceptable (UC-3.1, #185).
 *
 * Its own module, with no imports, so the app's test suite can run the body the
 * app really sends through the server's real rule (QA v3, V3-F18-04). The
 * route answered 400 to every claim the app made for weeks and nothing noticed:
 * the app's tests checked the body against a fake, and the server's tests
 * checked hand-written bodies. A file both sides can load is what closes that.
 */
export const DEVICE_CALENDAR_LINK_STATES = ['linked', 'detached'] as const;
export type DeviceCalendarLinkState = (typeof DEVICE_CALENDAR_LINK_STATES)[number];

export interface DeviceCalendarLink {
  /** The installation that owns this event. Compared for equality, never read. */
  writerId: string;
  calendarId: string;
  eventId: string;
  /** What was written, so a no-op edit does not touch the calendar. */
  contentHash: string;
  state: DeviceCalendarLinkState;
  writtenAt: string;
}

export class DeviceCalendarLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceCalendarLinkValidationError';
  }
}

export function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DeviceCalendarLinkValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

/** What a client may send. `writtenAt` is the server's clock, never theirs. */
export interface DeviceCalendarLinkInput {
  writerId: unknown;
  calendarId: unknown;
  eventId: unknown;
  contentHash: unknown;
  state: unknown;
}

export function parseDeviceCalendarLinkInput(input: DeviceCalendarLinkInput): Omit<DeviceCalendarLink, 'writtenAt'> {
  const state = input.state;
  if (!(DEVICE_CALENDAR_LINK_STATES as readonly unknown[]).includes(state)) {
    throw new DeviceCalendarLinkValidationError(
      `state must be one of ${DEVICE_CALENDAR_LINK_STATES.join(', ')}`,
    );
  }
  return {
    writerId: nonEmptyString(input.writerId, 'writerId'),
    calendarId: nonEmptyString(input.calendarId, 'calendarId'),
    eventId: nonEmptyString(input.eventId, 'eventId'),
    contentHash: nonEmptyString(input.contentHash, 'contentHash'),
    state: state as DeviceCalendarLinkState,
  };
}
