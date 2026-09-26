/**
 * Place reminders — the rules, with no native module in sight (closure CL4).
 *
 * ── Who decides what is watched ──────────────────────────────────
 *
 * The account. A commitment carries `locationTrigger` on the server; this
 * phone holds the pins. So what this phone watches is: every live commitment
 * in Today or Upcoming whose trigger names a place saved *here*. Those two
 * lists are every live commitment the account has (`placeInList` on the
 * server), which is what makes the rule total: done, dropped and deleted
 * commitments leave the lists and so leave the watch, whichever screen,
 * notification button or other device closed them.
 *
 * ── One shot, and never on the first look ────────────────────────
 *
 * Both platforms report where the phone *is* the moment a region is handed to
 * them (iOS `requestStateForRegion`, Android's `INITIAL_TRIGGER_ENTER|EXIT`),
 * and again every time the app relaunches and the regions are re-registered.
 * Taken at face value, "remind me when I arrive home" saved while at home
 * would ring at once, and again on every launch. So the first event a region
 * reports only records the side the phone is on; a reminder fires on a
 * *change* of side, in its own direction, and then once only.
 */
import { endOfQuietWindow, isInQuietWindow } from '../reminders/quietHours';
import type { Commitment, LocationTrigger } from '../../api/schemas/common';
import type { ArmedReminder, ArmedStore, Place, RegionSide } from '../../lib/deviceSettings/placeReminders';
import { ARMED_VERSION } from '../../lib/deviceSettings/placeReminders';

export const PLACE_REMINDER_TASK = 'maybesitter-place-reminder';

/** Metres. Big enough for GPS drift at a front door, small enough to mean "here". */
export const REGION_RADIUS_M = 150;

/** The server's `LOCATION_TRIGGER_LABEL_MAX`: a longer name is refused there. */
export const LOCATION_LABEL_MAX = 60;

/** iOS monitors at most twenty regions per app. */
export const MAX_REGIONS = 20;

/** The OS region and the scheduled notification share this, so a re-fire replaces. */
export function regionIdentifier(commitmentId: string): string {
  return `place-reminder.${commitmentId}`;
}

export function commitmentIdOfRegion(identifier: unknown): string | null {
  if (typeof identifier !== 'string' || !identifier.startsWith('place-reminder.')) return null;
  const id = identifier.slice('place-reminder.'.length);
  return id === '' ? null : id;
}

/** The statuses the lists call live. A proposal still waiting to be confirmed is not watched. */
const WATCHED_STATUSES = new Set(['active', 'deferred', 'missed']);

export function armedKey(trigger: LocationTrigger, place: Place): string {
  return `${trigger.kind}:${trigger.placeId}:${place.updatedAt}`;
}

export interface NotificationCopy {
  arrive(place: string): string;
  leave(place: string): string;
}

/**
 * What this phone should be watching, carrying over what it already knew.
 *
 * An entry whose key is unchanged keeps its side and its `firedAt`, so a
 * reminder that already rang does not ring again because the list refetched.
 * A changed key — the other direction, another place, or the pin moved — is a
 * new reminder and starts fresh.
 */
export function desiredArmed(
  commitments: readonly Commitment[],
  places: readonly Place[],
  previous: readonly ArmedReminder[],
  copy: NotificationCopy,
): ArmedReminder[] {
  const placeById = new Map(places.map(place => [place.id, place]));
  const before = new Map(previous.map(entry => [entry.commitmentId, entry]));
  const seen = new Set<string>();
  const out: ArmedReminder[] = [];
  for (const commitment of commitments) {
    if (seen.has(commitment.id)) continue;
    seen.add(commitment.id);
    const trigger = commitment.locationTrigger;
    if (!trigger || !WATCHED_STATUSES.has(commitment.status)) continue;
    const place = placeById.get(trigger.placeId);
    if (!place) continue;
    const key = armedKey(trigger, place);
    const kept = before.get(commitment.id);
    const same = kept !== undefined && kept.key === key;
    out.push({
      commitmentId: commitment.id,
      kind: trigger.kind,
      placeId: trigger.placeId,
      key,
      title: commitment.title,
      body: trigger.kind === 'arrive' ? copy.arrive(place.label) : copy.leave(place.label),
      side: same ? kept.side : null,
      firedAt: same ? kept.firedAt : null,
    });
  }
  return out;
}

export interface Region {
  identifier: string;
  latitude: number;
  longitude: number;
  radius: number;
  notifyOnEnter: true;
  notifyOnExit: true;
}

/**
 * The regions to hand the OS: every reminder that has not fired, capped at
 * the platform limit. Both edges are always watched — the side the phone is
 * on is how the first look is told apart from a crossing.
 */
export function regionsFor(entries: readonly ArmedReminder[], places: readonly Place[]): Region[] {
  const placeById = new Map(places.map(place => [place.id, place]));
  const regions: Region[] = [];
  for (const entry of entries) {
    if (entry.firedAt !== null) continue;
    const place = placeById.get(entry.placeId);
    if (!place) continue;
    regions.push({
      identifier: regionIdentifier(entry.commitmentId),
      latitude: place.latitude,
      longitude: place.longitude,
      radius: REGION_RADIUS_M,
      notifyOnEnter: true,
      notifyOnExit: true,
    });
    if (regions.length >= MAX_REGIONS) break;
  }
  return regions;
}

/** expo-location's numbering: Enter is 1, Exit is 2. */
export const GEOFENCE_ENTER = 1;
export const GEOFENCE_EXIT = 2;

export interface PlaceNotification {
  readonly identifier: string;
  readonly title: string;
  readonly body: string;
  readonly commitmentId: string;
  /** Null for now; an instant when quiet hours moved it. */
  readonly at: Date | null;
}

export interface GeofenceDeps {
  load(): Promise<ArmedStore | null>;
  save(store: ArmedStore): Promise<void>;
  notify(notification: PlaceNotification): Promise<void>;
  now(): Date;
}

export type GeofenceOutcome = 'fired' | 'recorded' | 'ignored';

/** The task's payload, read without trusting it. */
export function eventOf(payload: unknown): { side: RegionSide; commitmentId: string } | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as { data?: { eventType?: unknown; region?: { identifier?: unknown } }; error?: unknown };
  if (raw.error) return null;
  const eventType = raw.data?.eventType;
  const side: RegionSide | null = eventType === GEOFENCE_ENTER ? 'inside' : eventType === GEOFENCE_EXIT ? 'outside' : null;
  const commitmentId = commitmentIdOfRegion(raw.data?.region?.identifier);
  return side && commitmentId ? { side, commitmentId } : null;
}

/**
 * Every read-modify-write of the armed store goes through here: several
 * regions can report in the same instant (every region reports on
 * registration), and the in-app reconcile writes the same document.
 */
let queue: Promise<unknown> = Promise.resolve();
export function withArmedLock<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

/** One region event, as the OS delivers it to the headless task. */
export function handleGeofenceEvent(payload: unknown, deps: GeofenceDeps): Promise<GeofenceOutcome> {
  return withArmedLock(() => applyEvent(payload, deps));
}

async function applyEvent(payload: unknown, deps: GeofenceDeps): Promise<GeofenceOutcome> {
  const event = eventOf(payload);
  if (!event) return 'ignored';
  const store = await deps.load();
  if (!store) return 'ignored';
  const entry = store.entries.find(candidate => candidate.commitmentId === event.commitmentId);
  if (!entry || entry.firedAt !== null) return 'ignored';

  const previous = entry.side;
  const crossed = previous !== null && previous !== event.side;
  const wanted = (entry.kind === 'arrive' && event.side === 'inside') || (entry.kind === 'leave' && event.side === 'outside');
  const fires = crossed && wanted;
  const now = deps.now();

  const updated: ArmedReminder = { ...entry, side: event.side, firedAt: fires ? now.toISOString() : null };
  await deps.save({ ...store, entries: store.entries.map(candidate => (candidate === entry ? updated : candidate)) });

  if (previous === null) return 'recorded';
  if (!fires) return 'ignored';

  let at: Date | null = null;
  if (store.quiet && isInQuietWindow(store.quiet, now.getTime(), store.timeZone)) {
    const end = endOfQuietWindow(store.quiet, now.getTime(), store.timeZone);
    at = end === null ? null : new Date(end);
  }
  await deps.notify({
    identifier: regionIdentifier(entry.commitmentId),
    title: entry.title,
    body: entry.body,
    commitmentId: entry.commitmentId,
    at,
  });
  return 'fired';
}

/** A fresh store for an account, carrying nothing over from another one. */
export function emptyArmed(accountId: string): ArmedStore {
  return { version: ARMED_VERSION, accountId, quiet: null, timeZone: 'UTC', entries: [], registered: null };
}

/** The body the PATCH sends. Built from the three fields by name, so a place's pin cannot ride along. */
export function placeReminderBody(kind: 'arrive' | 'leave', place: Pick<Place, 'id' | 'label'>): LocationTrigger {
  return { kind, placeId: place.id, label: place.label.trim() };
}
