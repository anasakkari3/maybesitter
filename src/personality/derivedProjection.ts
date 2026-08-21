/**
 * The cold path's projection: everything personality synthesis is allowed to
 * know about a person, and nothing else.
 *
 * "Personality" here means the *user's* behavioural profile. It is unrelated
 * to `lib/services/personalityService.ts`, which fixes the assistant's own
 * tone and copy; the two never meet.
 */

export interface ProjectionEvent {
  kind: string;
  completedAt: Date | null;
  dropped: boolean;
  /** Present on the input, deliberately never copied into the output. */
  title?: string;
}

export interface DerivedProjection {
  window: { from: string; to: string };
  byKind: Record<string, number>;
  completionHours: number[];
  completed: number;
  dropped: number;
  observations: number;
}

/** Below this the profile is noise, not a pattern. */
export const MINIMUM_PROFILE_OBSERVATIONS = 3;

/** Where events whose `kind` is not a recognised category are counted. */
export const UNCLASSIFIED_KIND = 'other';

/**
 * The only keys the payload may carry. Used by the guard below rather than by
 * the builder, because the builder never copies keys in the first place.
 */
const ALLOWED_PROJECTION_KEYS = [
  'window',
  'byKind',
  'completionHours',
  'completed',
  'dropped',
  'observations',
] as const;

/**
 * `kind` is typed `string`, so a caller can put a commitment title in it by
 * mistake — and byKind's keys are part of what gets sent. A short lowercase
 * ASCII slug is a category; a sentence in any of the product's three
 * languages is not, and fails this on the first character or the first space.
 */
const KIND_SLUG = /^[a-z][a-z0-9_]{0,31}$/;

/** The exact shape `Date.prototype.toISOString` produces, and nothing looser. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function normaliseKind(kind: string): string {
  return KIND_SLUG.test(kind) ? kind : UNCLASSIFIED_KIND;
}

function withinWindow(at: Date, window: { from: Date; to: Date }): boolean {
  return at >= window.from && at <= window.to;
}

/**
 * The hour the person experienced, not the hour UTC recorded.
 *
 * A completion at 09:00 in Asia/Jerusalem is 06:00Z in summer and 07:00Z in
 * winter, so reading UTC both shifts every habit by the offset and smears one
 * routine across two buckets at the DST boundary. This repo is careful about
 * that everywhere else (see src/planning/sharedTime); the cold path should
 * not be the exception. Falling back to UTC when no timezone is given is a
 * caller's choice, not a silent default we can improve on.
 */
function localHour(at: Date, timezone: string | undefined): number {
  if (!timezone) return at.getUTCHours();
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  }).format(at);
  return Number(hour) % 24;
}

/**
 * Everything the cold path is allowed to know: counts, kinds and hours.
 *
 * The input carries titles; the output must not. Every field below is written
 * by hand from a value this function computed — there is deliberately no
 * `...event`, no `Object.assign` and no key iteration over the input anywhere
 * in this file, because any of those would carry an undeclared property
 * straight through the boundary. A type annotation would not have stopped it:
 * an object with extra keys still satisfies `ProjectionEvent`.
 *
 * This is what keeps the on-device analysis promise true while still letting a
 * frontier model reason about behaviour — and it is why the escalation path's
 * injection surface does not exist here: integers cannot carry instructions.
 */
export function buildDerivedProjection(
  events: ProjectionEvent[],
  window: { from: Date; to: Date },
  options: { timezone?: string } = {},
): DerivedProjection {
  // Object.create(null) rather than {}: 'constructor' and 'toString' pass the
  // slug test, and on a plain object `byKind[kind] ?? 0` reads an inherited
  // function instead of undefined -- so the count became a string while the
  // type still said number.
  const byKind: Record<string, number> = Object.create(null);
  const completionHours: number[] = [];
  let completed = 0;
  let dropped = 0;
  let observations = 0;

  for (const event of events) {
    // The window is part of the payload, so it has to be true of the payload.
    // Counting an event from 2019 inside a August-2026 window makes the
    // projection assert something it does not represent.
    if (event.completedAt && !withinWindow(event.completedAt, window)) continue;
    observations += 1;

    const kind = normaliseKind(event.kind);
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (event.dropped) dropped += 1;
    if (event.completedAt) {
      completed += 1;
      completionHours.push(localHour(event.completedAt, options.timezone));
    }
  }

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    // Back to a plain object for the payload: JSON.stringify handles a
    // null-prototype object fine, but the guard's typeof/Object.entries
    // checks read more predictably against an ordinary one.
    byKind: { ...byKind },
    completionHours,
    completed,
    dropped,
    observations,
  };
}

/**
 * Whether a projection is free of anything a human could read as text.
 *
 * The builder already guarantees this for projections it just produced. The
 * guard exists for the ones it did not: a projection read back from storage,
 * decoded from a request, or assembled by a future caller that took a
 * shortcut. Structure is checked, not types — `DerivedProjection` is erased
 * by the time this runs.
 */
export function projectionCarriesNoText(projection: DerivedProjection): boolean {
  if (projection === null || typeof projection !== 'object') return false;

  // Object.keys is not what goes on the wire. JSON.stringify ignores the own
  // keys entirely when the object has a toJSON method, and a method on the
  // prototype is invisible to Object.keys -- so a class instance could pass
  // every check below and still serialise titles and a person's name. Only a
  // plain object serialises to what this function inspected.
  if (Object.getPrototypeOf(projection) !== Object.prototype) return false;
  if ('toJSON' in projection) return false;

  const keys = Object.keys(projection);
  if (keys.length !== ALLOWED_PROJECTION_KEYS.length) return false;
  if (!keys.every((key) => (ALLOWED_PROJECTION_KEYS as readonly string[]).includes(key))) {
    return false;
  }

  const window = projection.window;
  if (window === null || typeof window !== 'object') return false;
  const windowKeys = Object.keys(window);
  if (windowKeys.length !== 2) return false;
  if (!ISO_INSTANT.test(window.from) || !ISO_INSTANT.test(window.to)) return false;
  // A window that runs backwards describes no period at all.
  if (window.from > window.to) return false;

  if (!Array.isArray(projection.completionHours)) return false;
  if (
    !projection.completionHours.every(
      (hour) => typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23,
    )
  ) {
    return false;
  }

  if (!isCount(projection.completed)) return false;
  if (!isCount(projection.dropped)) return false;
  if (!isCount(projection.observations)) return false;

  const byKind = projection.byKind;
  if (byKind === null || typeof byKind !== 'object') return false;
  for (const [kind, count] of Object.entries(byKind)) {
    if (!KIND_SLUG.test(kind)) return false;
    if (!isCount(count)) return false;
  }

  return true;
}

/**
 * The single gate in front of the cold path.
 *
 * It enforces two separate things, and the no-text check comes first: a
 * projection that leaks a title is not made acceptable by having enough
 * observations, and a count on its own has never proved anything about
 * content. Checking only `observations` here would leave the function's name
 * promising a guarantee it does not provide.
 */
export function projectionIsSendable(projection: DerivedProjection): boolean {
  if (!projectionCarriesNoText(projection)) return false;
  return projection.observations >= MINIMUM_PROFILE_OBSERVATIONS;
}
