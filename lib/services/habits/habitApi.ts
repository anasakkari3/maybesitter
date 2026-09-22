/**
 * What `/api/mobile/habits/**` is allowed to say and to be told (#520).
 *
 * Much smaller than it was, and the deletion is the point. This file used to
 * hold a second validator for habits — its own title bounds, its own cadence
 * parse, its own occurrence-bound check — written against a transcribed
 * contract while the domain lane was still building the real one. That
 * validator is gone. `src/contracts/v1/habitContracts.ts` owns every rule about
 * what a habit may be, and the route layer's remaining jobs are the two that
 * genuinely belong to a boundary:
 *
 *  1. **Identity.** A path segment is checked against the shape the thing's own
 *     minting produces, before any read, so a segment cannot be a probe.
 *  2. **Presentation.** What leaves the boundary, which is not the same as what
 *     is stored.
 *
 * Everything else is `parseHabitDefinitionInput` and `parseHabitPatchInput`,
 * called directly. Two validators for one contract is how the two lanes of
 * #520 would have come to disagree about what a legal cadence is while both
 * suites stayed green — which is exactly the failure this reconciliation
 * exists to remove.
 *
 * ── The body still cannot choose the tree ───────────────────────
 *
 * `parseHabitDefinitionInput` requires a `scopeId`, and the routes supply the
 * verified uid *after* spreading the body, so a `scopeId` a client sent is
 * overwritten rather than honoured. That ordering is load-bearing and
 * `habitRoutes.test.ts` presses it.
 *
 * ── Validation errors carry a message, not a code ───────────────
 *
 * The domain's `HabitValidationError` is a message, and this boundary reports
 * it as one. The `reason` codes this file used to mint are gone with the
 * validator that produced them: deriving a stable code from somebody else's
 * prose would be inventing a contract the domain never agreed to, and the
 * messages already name the offending field.
 */
import { HabitValidationError } from '../../../src/contracts/v1/habitContracts';
import type {
  HabitDefinition,
  HabitOccurrence,
} from '../../../src/contracts/v1/habitContracts';

export { HabitValidationError };

export function habitValidationResponse(error: HabitValidationError): Response {
  return Response.json({ success: false, error: error.message }, { status: 400 });
}

/**
 * The habit id shape, which is `randomUUID()` exactly.
 *
 * Checked against what `StorageHabitStore.create` mints rather than against
 * "a non-empty string", so a path segment that was never an id this system
 * produced is refused before it reaches a document path.
 */
const HABIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The occurrence id shape: `{habitId}.{localDate}.{ordinal}`.
 *
 * Derived from `occurrenceIdFor`, and deliberately checked in full rather than
 * loosely. The id is used as a document id, so a segment containing a slash or
 * a traversal must not survive this function — and because the shape is
 * deterministic, "is this an id we could have minted" is answerable here
 * without a read.
 */
const OCCURRENCE_ID = new RegExp(
  `^${HABIT_ID.source.slice(1, -1)}\\.\\d{4}-\\d{2}-\\d{2}\\.\\d+$`,
  'i',
);

export function parseHabitId(raw: unknown): string {
  if (typeof raw !== 'string' || !HABIT_ID.test(raw)) {
    throw new HabitValidationError('not a habit id');
  }
  return raw;
}

export function parseOccurrenceId(raw: unknown): string {
  if (typeof raw !== 'string' || !OCCURRENCE_ID.test(raw)) {
    throw new HabitValidationError('not an occurrence id');
  }
  return raw;
}

/**
 * The keys a request body may carry, and nothing else.
 *
 * This is *not* a second copy of the domain's validation, and the distinction
 * is worth being exact about. `parseHabitDefinitionInput` says what a habit
 * **is** — which cadences are legal, how the counts relate, that a confirmation
 * is required — and it reads the fields it knows and ignores the rest, which is
 * right for a function that also runs over a document read back from storage.
 *
 * What a *request* may contain is a different question and it belongs at the
 * boundary. A body carrying a key nothing reads is a 400 here rather than a
 * silent drop, because the failure mode is the client that sets
 * `maxShiftMinutes: 30`, gets a 201, and is never told the habit it created has
 * no bound on how far it moves.
 *
 * `scopeId` is absent on purpose: it is supplied by the route from the verified
 * token, so a body that names one is refused rather than overwritten — which is
 * a clearer answer than silently ignoring an attempt to choose a tree.
 */
const NEW_HABIT_KEYS = new Set([
  'title', 'cadence', 'durationMinutes', 'preferredWindows',
  'minimumOccurrences', 'maximumOccurrences', 'flexibility', 'recoveryPolicy',
  'source', 'confirmation',
]);

/** A patch may not restate where a habit came from, nor re-sign its receipt. */
const PATCH_HABIT_KEYS = new Set([
  'title', 'cadence', 'durationMinutes', 'preferredWindows',
  'minimumOccurrences', 'maximumOccurrences', 'flexibility', 'recoveryPolicy', 'status',
]);

function refuseUnknown(body: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new HabitValidationError(`${where} does not accept "${key}"`);
  }
}

/** The body of a create request, as an object with only keys this API reads. */
export function checkNewHabitBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HabitValidationError('body must be an object');
  }
  refuseUnknown(body as Record<string, unknown>, NEW_HABIT_KEYS, 'a habit');
  return body as Record<string, unknown>;
}

/** The body of a patch request. Empty is refused rather than treated as a no-op. */
export function checkHabitPatchBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HabitValidationError('body must be an object');
  }
  refuseUnknown(body as Record<string, unknown>, PATCH_HABIT_KEYS, 'a habit patch');
  if (Object.keys(body as Record<string, unknown>).length === 0) {
    throw new HabitValidationError('nothing to change');
  }
  return body as Record<string, unknown>;
}

/**
 * The create body, with the scope forced to the verified account.
 *
 * A named function rather than an inline `{ ...body, scopeId: user.uid }` in
 * the route, because the *ordering* is the security property and an inline
 * spread is a line no test can reach on its own. `checkNewHabitBody` already
 * refuses a body that carries `scopeId` at all, so in the shipped route these
 * are two defences over one hole — but the day somebody adds `scopeId` to the
 * accepted keys, this is what keeps a token from writing into another person's
 * tree, and it should not be the day a test first covers it.
 *
 * The uid goes last. That is the whole function.
 */
export function withVerifiedScope(
  body: Record<string, unknown>,
  uid: string,
): Record<string, unknown> {
  return { ...body, scopeId: uid };
}

/* ── Presentation ────────────────────────────────────────────────── */

/**
 * One habit as the client reads it.
 *
 * `scopeId` is left off: the client already knows whose account it asked
 * about, and echoing the uid into every row of a list response puts an account
 * identifier on the wire once per habit for no reader that needs it.
 *
 * `confirmation` **is** included, and that is a deliberate difference. It is
 * the receipt for the act that created the habit — the thing that makes "goal
 * text never becomes a habit on its own" checkable rather than asserted — so a
 * client showing the user what they agreed to, and when, can.
 */
export function presentHabit(definition: HabitDefinition) {
  return {
    habitId: definition.habitId,
    title: definition.title,
    cadence: definition.cadence,
    durationMinutes: definition.durationMinutes,
    preferredWindows: definition.preferredWindows,
    minimumOccurrences: definition.minimumOccurrences,
    maximumOccurrences: definition.maximumOccurrences,
    flexibility: definition.flexibility,
    recoveryPolicy: definition.recoveryPolicy,
    status: definition.status,
    source: definition.source,
    confirmation: definition.confirmation,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  };
}

/**
 * One occurrence as the client reads it.
 *
 * `ordinal` and `recoveredFromOccurrenceId` travel, because together they are
 * how a client tells cadence demand from a replacement the recovery policy
 * produced — which is the difference between "Wednesday's gym session" and
 * "the make-up for Monday's", and the user is owed that distinction.
 */
export function presentOccurrence(occurrence: HabitOccurrence) {
  return {
    occurrenceId: occurrence.occurrenceId,
    habitId: occurrence.habitId,
    localDate: occurrence.localDate,
    ordinal: occurrence.ordinal,
    state: occurrence.state,
    durationMinutes: occurrence.durationMinutes,
    recoveredFromOccurrenceId: occurrence.recoveredFromOccurrenceId,
  };
}
