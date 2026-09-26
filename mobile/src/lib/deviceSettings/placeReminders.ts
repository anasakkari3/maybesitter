/**
 * Saved places and the place reminders this phone is watching (closure CL4).
 *
 * ── Why this may live in `src/lib/deviceSettings` ────────────────
 *
 * The directory README asks every addition to argue for itself. Here it is.
 *
 * **Places** are a name and a pin: `Home` at a latitude and longitude. They
 * are the one thing in this app that is deliberately *never* sent to the
 * server — `locationTriggerContracts.ts` refuses a coordinate by name — so the
 * phone is the only place they can live. Keyed by account and cleared on
 * sign-out and account deletion, like the routine cache.
 *
 * **Armed reminders** are what the geofence task needs when the OS wakes the
 * app with no React tree, no query cache and possibly no session: which
 * commitment a region belongs to, whether it fires on arrival or on leaving,
 * the notification's title and line, whether the phone was last inside or
 * outside, and whether it already fired. The title is the commitment's title —
 * the same text the OS already holds for every scheduled reminder — kept here
 * because a region crossing cannot wait for a network round trip to say what
 * it is about. One entry per commitment with a place reminder, capped at the
 * iOS region limit, and cleared on sign-out.
 *
 * Nothing in either store is sent anywhere.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const PLACES_VERSION = 1;
export const ARMED_VERSION = 1;
export const ARMED_KEY = 'placeReminders.armed.v1';

export function placesStorageKey(accountId: string): string {
  return `places.v1.${accountId}`;
}

export type PlaceKind = 'home' | 'work' | 'custom';

export interface Place {
  readonly id: string;
  readonly kind: PlaceKind;
  /** The name the person gave it. For Home and Work, the localised word at the time it was saved. */
  readonly label: string;
  readonly latitude: number;
  readonly longitude: number;
  /** When the pin was last set. Moving Home re-arms every reminder on it. */
  readonly updatedAt: string;
}

export type RegionSide = 'inside' | 'outside';

export interface ArmedReminder {
  readonly commitmentId: string;
  readonly kind: 'arrive' | 'leave';
  readonly placeId: string;
  /** `${kind}:${placeId}:${place.updatedAt}` — a different value is a different reminder. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  /** Where the phone was at the last event, or null before the first one. */
  readonly side: RegionSide | null;
  readonly firedAt: string | null;
}

export interface ArmedStore {
  readonly version: number;
  readonly accountId: string;
  readonly quiet: { readonly start: string; readonly end: string } | null;
  readonly timeZone: string;
  readonly entries: readonly ArmedReminder[];
  /** The regions last handed to the OS successfully, as JSON; null when none are. */
  readonly registered: string | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlace(value: unknown): value is Place {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === 'string' && raw.id !== ''
    && (raw.kind === 'home' || raw.kind === 'work' || raw.kind === 'custom')
    && typeof raw.label === 'string' && raw.label.trim() !== ''
    && isFiniteNumber(raw.latitude) && Math.abs(raw.latitude) <= 90
    && isFiniteNumber(raw.longitude) && Math.abs(raw.longitude) <= 180
    && typeof raw.updatedAt === 'string';
}

/** A stored blob, or none. A version this build does not know reads as empty. */
export function parsePlaces(raw: string | null): Place[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as { version?: unknown; places?: unknown };
    if (value.version !== PLACES_VERSION || !Array.isArray(value.places)) return [];
    return value.places.filter(isPlace);
  } catch {
    return [];
  }
}

export async function loadPlaces(accountId: string): Promise<Place[]> {
  try {
    return parsePlaces(await AsyncStorage.getItem(placesStorageKey(accountId)));
  } catch {
    return [];
  }
}

export async function savePlaces(accountId: string, places: readonly Place[]): Promise<void> {
  await AsyncStorage.setItem(placesStorageKey(accountId), JSON.stringify({ version: PLACES_VERSION, places }));
}

function isArmed(value: unknown): value is ArmedReminder {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.commitmentId === 'string' && (raw.kind === 'arrive' || raw.kind === 'leave')
    && typeof raw.placeId === 'string' && typeof raw.key === 'string'
    && typeof raw.title === 'string' && typeof raw.body === 'string'
    && (raw.side === null || raw.side === 'inside' || raw.side === 'outside')
    && (raw.firedAt === null || typeof raw.firedAt === 'string');
}

export function parseArmed(raw: string | null): ArmedStore | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ArmedStore>;
    if (value.version !== ARMED_VERSION || typeof value.accountId !== 'string' || !Array.isArray(value.entries)) return null;
    return {
      version: ARMED_VERSION,
      accountId: value.accountId,
      quiet: value.quiet && typeof value.quiet.start === 'string' && typeof value.quiet.end === 'string'
        ? { start: value.quiet.start, end: value.quiet.end }
        : null,
      timeZone: typeof value.timeZone === 'string' ? value.timeZone : 'UTC',
      entries: value.entries.filter(isArmed),
      registered: typeof value.registered === 'string' ? value.registered : null,
    };
  } catch {
    return null;
  }
}

export async function loadArmed(): Promise<ArmedStore | null> {
  try {
    return parseArmed(await AsyncStorage.getItem(ARMED_KEY));
  } catch {
    return null;
  }
}

export async function saveArmed(store: ArmedStore): Promise<void> {
  await AsyncStorage.setItem(ARMED_KEY, JSON.stringify(store));
}

/** Sign-out and account deletion: this account's places, and everything armed. */
export async function clearPlaceReminders(accountId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(placesStorageKey(accountId));
  } catch {
    // Nothing more can be done from here; the next sign-in reads its own key.
  }
  try {
    await AsyncStorage.removeItem(ARMED_KEY);
  } catch {
    // As above.
  }
}
