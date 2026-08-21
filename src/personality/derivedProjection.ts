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
): DerivedProjection {
  const byKind: Record<string, number> = {};
  const completionHours: number[] = [];
  let completed = 0;
  let dropped = 0;

  for (const event of events) {
    const kind = normaliseKind(event.kind);
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (event.dropped) dropped += 1;
    if (event.completedAt) {
      completed += 1;
      completionHours.push(event.completedAt.getUTCHours());
    }
  }

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    byKind,
    completionHours,
    completed,
    dropped,
    observations: events.length,
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
