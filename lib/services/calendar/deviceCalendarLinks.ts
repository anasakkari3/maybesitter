/**
 * Which event in the user's own calendar a commitment was written to, and
 * which installation owns it (UC-3.1, #185).
 *
 * ── This is the whole of the duplicate-suppression story ─────────
 *
 * Two phones signed into one account both see the same confirmed commitment,
 * both have the calendar target on, and both would write an event. On iOS they
 * may even be writing into the same iCloud calendar, so the user would get two
 * identical entries and deleting one would leave the other.
 *
 * The rule that prevents it is here and not on either phone: the *first* writer
 * to store a link owns it, and a `PUT` from any other writer is refused with
 * 409. The loser writes nothing. It is a compare-and-set on one document, so
 * two devices racing at the same second cannot both win — which a rule
 * implemented on the devices could never promise, because neither device can
 * see the other.
 *
 * ── `writerId`, and why it is not called `installationId` ────────
 *
 * It is whatever the installation calls itself: a random value the app minted
 * and kept, never a device identifier and never derived from one. #185's sketch
 * names it `installationId` and points at `mobile/src/lib/installationId.ts`
 * from UC-3.0b (#184), which is being built in another lane as this lands. This
 * field is named for what it *means* here rather than for one possible source,
 * so when #184's value arrives the app passes it in and nothing stored has to
 * change: the id simply becomes more durable than the one it replaces.
 *
 * The server never interprets it. It compares it for equality and nothing else.
 *
 * ── `detached` is a tombstone, and that is the point ─────────────
 *
 * When the user deletes the event in their Calendar app, the app records
 * `detached`. From then on every `PUT` asking for `linked` on that commitment
 * is refused. The alternative — letting the next edit write the event again —
 * is the product overruling somebody who took an explicit action in another
 * app, repeatedly, and it is the failure this state exists to make impossible.
 *
 * A tombstone is not forever: `DELETE` removes the row, which is what the
 * "Remove events MaybeSitter added" button does for the links it still owns.
 */
import { getStorage, type StorageAdapter } from '../../storage';
import { DEVICE_CALENDAR_LINKS, userCol, userSubDoc } from '../../storage/paths';

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

/** The refusals this module makes, each with the reason a route sends back. */
export class DeviceCalendarLinkConflictError extends Error {
  constructor(message: string, readonly reason: 'owned_elsewhere' | 'detached') {
    super(message);
    this.name = 'DeviceCalendarLinkConflictError';
  }
}

export class DeviceCalendarLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceCalendarLinkValidationError';
  }
}

export interface DeviceCalendarLinkDeps {
  storage?: StorageAdapter;
}

function storageOf(deps: DeviceCalendarLinkDeps): StorageAdapter {
  return deps.storage ?? getStorage();
}

function nonEmptyString(value: unknown, field: string): string {
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

export async function getDeviceCalendarLink(
  uid: string,
  commitmentId: string,
  deps: DeviceCalendarLinkDeps = {},
): Promise<DeviceCalendarLink | null> {
  return storageOf(deps).get<DeviceCalendarLink>(userSubDoc(uid, DEVICE_CALENDAR_LINKS, commitmentId));
}

/**
 * Every link this account holds, keyed by commitment id.
 *
 * One read for a whole list rather than one read per commitment: the lists are
 * the only place these are consumed, and a join that cost a round trip per row
 * would make Today's response depend on how many commitments somebody has.
 */
export async function listDeviceCalendarLinks(
  uid: string,
  deps: DeviceCalendarLinkDeps = {},
): Promise<Map<string, DeviceCalendarLink>> {
  const rows = await storageOf(deps).list<DeviceCalendarLink>(userCol(uid, DEVICE_CALENDAR_LINKS));
  return new Map(rows.map((row) => [row.id, row.data]));
}

/**
 * Claims, or updates, the link for one commitment.
 *
 * Inside a transaction, so the read that decides and the write that acts cannot
 * be separated by another device's write. Every refusal below happens *before*
 * anything is stored.
 */
export async function putDeviceCalendarLink(
  uid: string,
  commitmentId: string,
  input: DeviceCalendarLinkInput,
  now: Date,
  deps: DeviceCalendarLinkDeps = {},
): Promise<DeviceCalendarLink> {
  const parsed = parseDeviceCalendarLinkInput(input);
  const path = userSubDoc(uid, DEVICE_CALENDAR_LINKS, commitmentId);
  return storageOf(deps).runTransaction(async (tx) => {
    const current = await tx.get<DeviceCalendarLink>(path);
    if (current) {
      if (current.writerId !== parsed.writerId) {
        throw new DeviceCalendarLinkConflictError(
          'another installation already writes this commitment to a calendar',
          'owned_elsewhere',
        );
      }
      // The one transition that is refused. Everything else — a content hash
      // moving, a linked row being detached — is the owner telling us what they
      // did, and is recorded.
      if (current.state === 'detached' && parsed.state === 'linked') {
        throw new DeviceCalendarLinkConflictError(
          'this commitment was removed from the calendar by hand and is not written again',
          'detached',
        );
      }
    }
    const next: DeviceCalendarLink = { ...parsed, writtenAt: now.toISOString() };
    tx.set(path, next);
    return next;
  });
}

/**
 * Forgets the link.
 *
 * Only the owner may, for the same reason only the owner may update: a second
 * device deleting the row would let a third write a duplicate event into a
 * calendar it cannot see. Deleting a row that is not there is not an error —
 * the caller asked for it to be gone, and it is.
 */
export async function deleteDeviceCalendarLink(
  uid: string,
  commitmentId: string,
  writerId: unknown,
  deps: DeviceCalendarLinkDeps = {},
): Promise<{ deleted: boolean }> {
  const writer = nonEmptyString(writerId, 'writerId');
  const path = userSubDoc(uid, DEVICE_CALENDAR_LINKS, commitmentId);
  return storageOf(deps).runTransaction(async (tx) => {
    const current = await tx.get<DeviceCalendarLink>(path);
    if (!current) return { deleted: false };
    if (current.writerId !== writer) {
      throw new DeviceCalendarLinkConflictError(
        'another installation owns this calendar event',
        'owned_elsewhere',
      );
    }
    tx.delete(path);
    return { deleted: true };
  });
}
