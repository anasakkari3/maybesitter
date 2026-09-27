/**
 * "Remind me when I arrive / leave" — what the server may know about it
 * (closure CL4, council verdict item 4).
 *
 * ── The coordinates never leave the phone ────────────────────────
 *
 * A place is a pin on somebody's home or office. The phone needs the pin to
 * ask the OS to watch a region; nothing on the server does anything with it.
 * So the server stores only that a commitment *has* a place reminder: which
 * way it fires, an opaque id the phone minted for the place, and the name the
 * person gave it — so another device, or the plan, can say "when you arrive at
 * Work" without knowing where Work is.
 *
 * The allow-list below is the whole wire shape. Anything else in the object is
 * refused, and the forbidden list names the fields a well-meaning client would
 * be most tempted to add, so a refusal says why rather than silently dropping
 * them and letting the client believe they were stored.
 */

export const LOCATION_TRIGGER_CONTRACT_VERSION = 'location-trigger-v1';

export const LOCATION_TRIGGER_KINDS = ['arrive', 'leave'] as const;

export type LocationTriggerKind = (typeof LOCATION_TRIGGER_KINDS)[number];

export interface LocationTrigger {
  kind: LocationTriggerKind;
  /** Minted on the phone. Means nothing without that phone's place list. */
  placeId: string;
  /** The name the person gave the place ("Home", "Work", "Gym"). Never an address. */
  label: string;
}

/** The only keys a location trigger may carry. */
export const LOCATION_TRIGGER_FIELDS = ['kind', 'placeId', 'label'] as const;

/**
 * Keys that would put a position on the server. Refused by name, so the error
 * says what was wrong. Compared case-insensitively.
 */
export const LOCATION_TRIGGER_FORBIDDEN_FIELDS = [
  'lat',
  'lng',
  'lon',
  'long',
  'latitude',
  'longitude',
  'coords',
  'coordinates',
  'position',
  'location',
  'center',
  'radius',
  'accuracy',
  'altitude',
  'address',
  'geohash',
] as const;

export const LOCATION_TRIGGER_LABEL_MAX = 60;

/** The phone mints `place_` + a uuid; the pattern leaves room and nothing else. */
const PLACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export class LocationTriggerValidationError extends Error {
  constructor(readonly field: string) {
    // No value in the message: a label is the user's own words.
    super(`locationTrigger.${field} is invalid`);
    this.name = 'LocationTriggerValidationError';
  }
}

export function isLocationTriggerKind(value: unknown): value is LocationTriggerKind {
  return typeof value === 'string' && (LOCATION_TRIGGER_KINDS as readonly string[]).includes(value);
}

/**
 * The trigger, normalised, or a `LocationTriggerValidationError` naming the
 * first field that is wrong. A forbidden key is refused before anything else
 * is looked at, so a coordinate can never ride along with a valid trigger.
 */
export function parseLocationTrigger(value: unknown): LocationTrigger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocationTriggerValidationError('shape');
  }
  const raw = value as Record<string, unknown>;
  const forbidden = new Set<string>(LOCATION_TRIGGER_FORBIDDEN_FIELDS);
  for (const key of Object.keys(raw)) {
    if (forbidden.has(key.toLowerCase())) throw new LocationTriggerValidationError(key);
    if (!(LOCATION_TRIGGER_FIELDS as readonly string[]).includes(key)) throw new LocationTriggerValidationError(key);
  }
  if (!isLocationTriggerKind(raw.kind)) throw new LocationTriggerValidationError('kind');
  if (typeof raw.placeId !== 'string' || !PLACE_ID.test(raw.placeId)) {
    throw new LocationTriggerValidationError('placeId');
  }
  if (typeof raw.label !== 'string') throw new LocationTriggerValidationError('label');
  const label = raw.label.trim();
  if (label.length === 0 || label.length > LOCATION_TRIGGER_LABEL_MAX || CONTROL_CHARACTERS.test(label)) {
    throw new LocationTriggerValidationError('label');
  }
  return { kind: raw.kind, placeId: raw.placeId, label };
}
