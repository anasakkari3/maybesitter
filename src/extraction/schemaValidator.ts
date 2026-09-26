/**
 * Schema validator for LLM-produced ExtractionResult JSON.
 *
 * Responsibilities:
 *  - Coerce and normalise fields into the ExtractionResult shape
 *  - Filter ambiguityFlags / missingFields to known enum values
 *  - Enforce safety rules (negation caps confidence)
 *  - Reconcile the model's instant against its own `localTimeSpec`, and remove
 *    a time the text never stated (UC-2.2, #162)
 *  - Stamp parserVersion: 'capture-v2'
 *  - Throw ValidationError when the payload is structurally unrecoverable
 */

import type {
  AmbiguityFlag,
  ExtractionContext,
  ExtractionResult,
  ExtractionType,
  LocalTimeSpec,
  MissingField,
} from './extractionTypes';
import {
  forbidsResolvedTime,
  instantFromLocal,
  localTimeSpecFor,
  timeAnchorOf,
  timeOfDayEvidence,
} from './timeLexicon';
import { isCommitmentCategory } from '../contracts/v1/categoryContracts';
import { modelDateIsWeekdayGuess, namesExplicitDate, readWeekdayReference } from './weekdayLexicon';
import { isFixedAppointment } from './priorityLexicon';
import { stripCaptureCommand } from './captureCommand';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const PARSER_VERSION = 'capture-v2';

const VALID_TYPES = new Set<ExtractionType>(['task', 'follow_up', 'informational_context', 'unknown']);
const VALID_AMBIGUITY_FLAGS = new Set<AmbiguityFlag>([
  'multiple_commitments',
  'vague_time',
  'vague_action',
  'weak_commitment_language',
  'informational_without_action',
  'contradictory_time',
  'negated_request',
  // Asked for by the prompt since UC-2.0 and dropped here ever since, because
  // this allow-list never carried it (#162).
  'no_action_verb',
]);

/** A model time more than this far from its own `localTimeSpec` is overruled. */
const RECONCILE_TOLERANCE_MS = 60_000;
/** Past this, the two disagree about more than rounding, and that is reported. */
const CONTRADICTION_MS = 12 * 60 * 60 * 1_000;
const VALID_MISSING_FIELDS = new Set<MissingField>(['action', 'time', 'person', 'commitment_strength']);

function clamp(value: unknown, min = 0, max = 1): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

function isoStringOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s.length === 0) return null;
  const ts = Date.parse(s);
  if (isNaN(ts)) throw new ValidationError(`${field} must be a valid date`);
  return new Date(ts).toISOString();
}

function commandFree(value: string | null): string | null {
  return value === null ? null : stripCaptureCommand(value);
}

function boolOrDefault(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


/**
 * The `localTimeSpec` the model returned, or null when it returned none.
 *
 * A day with no hour is kept (L4). The prompt tells the model to answer
 * "Sunday" with `time: null`, and this used to drop the whole spec for it — so
 * on the model path the Sunday it had picked vanished, and the review card had
 * no day to show or to call a guess. The date has to be a real `YYYY-MM-DD`:
 * it now reaches the phone as `resolvedDate`, whose schema would refuse the
 * whole proposal over a malformed one.
 */
function localTimeSpecFrom(raw: unknown): LocalTimeSpec | null {
  if (!isRecord(raw)) return null;
  const date = stringOrNull(raw['date']);
  const time = stringOrNull(raw['time']);
  const timezone = stringOrNull(raw['timezone']);
  if (!date || !timezone || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) return null;
  return { date, time, timezone };
}

/**
 * The day an instant falls on, with no hour.
 *
 * Used when a time has to be dropped but the date it named is still worth
 * keeping: the model computed an instant from a day it did read correctly.
 */
function anchorDayFrom(instant: string | null, zone: string): LocalTimeSpec | null {
  if (!instant) return null;
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed)) return null;
  const spec = localTimeSpecFor(new Date(parsed), zone);
  return spec ? { ...spec, time: null } : null;
}

export interface ReconciledTime {
  dueAt: string | null;
  remindAt: string | null;
  localTimeSpec: LocalTimeSpec | null;
  timeEvidence: ExtractionResult['timeEvidence'];
  /** Flags the reconciliation itself established. */
  flags: AmbiguityFlag[];
}

/**
 * Decides the time, from the text and the user's zone — not from the model's
 * arithmetic (UC-2.2, #162).
 *
 * Two independent things happen here, in this order, and both are deliberate.
 *
 * **1. The wall clock wins over the instant.** The model is asked for a
 * `localTimeSpec` (a date, a time and a zone) *and* a UTC `dueAt`. Those can
 * disagree, and when they do the `localTimeSpec` is right: it says "09:00 in
 * Europe/Berlin", which cannot be wrong about its own offset, while `dueAt`
 * required the model to do timezone arithmetic — which it gets wrong by whole
 * hours, silently, and most often for exactly the users who are not in UTC. So
 * the instant is recomputed from the wall clock. Past twelve hours the two are
 * not disagreeing about an offset any more, and `contradictory_time` says so.
 *
 * **2. A time the text does not state is removed.** This is the "no invented
 * time" rule, and it is the reason this function exists in code rather than as
 * a sentence in the prompt: a prompt can be ignored, argued with, or
 * overridden by the very text it is reading. `forbidsResolvedTime` is true when
 * the sentence names no time of day at all — "call mom", or a bare
 * "remind me tomorrow" — and in that case any time is the product's invention,
 * so it is dropped and `vague_time` is raised for the clarification step to
 * pick up (#165).
 *
 * The zone comes from `context.timezone`, which the device reported. It is
 * never taken from the model's `localTimeSpec.timezone`: a model that names a
 * zone is guessing at one, and a guessed zone would move every time it
 * touched.
 */
export function reconcileLocalTimeSpec(
  parsed: { dueAt: string | null; remindAt: string | null; localTimeSpec: LocalTimeSpec | null },
  rawText: string,
  context?: ExtractionContext,
): ReconciledTime {
  const flags: AmbiguityFlag[] = [];
  const evidence = timeOfDayEvidence(rawText);
  const zone = context?.timezone || parsed.localTimeSpec?.timezone || 'UTC';

  // The text states no time of day: nothing here may carry one. The *day* is
  // kept when the model named one, because "you said Sunday — what time?" is a
  // far better question than "when?", and only the hour was ever invented.
  if (forbidsResolvedTime(rawText)) {
    if (parsed.dueAt || parsed.remindAt || parsed.localTimeSpec?.time) flags.push('vague_time');
    const dayOnly = parsed.localTimeSpec
      ? { date: parsed.localTimeSpec.date, time: null, timezone: zone }
      : anchorDayFrom(parsed.dueAt || parsed.remindAt, zone);
    return { dueAt: null, remindAt: null, localTimeSpec: dayOnly, timeEvidence: evidence, flags };
  }

  let dueAt = parsed.dueAt;
  let remindAt = parsed.remindAt;
  let localTimeSpec = parsed.localTimeSpec;

  // Only a spec carrying an hour can produce an instant; a day-only spec is
  // already the honest answer and has nothing to reconcile against.
  const recomputed = localTimeSpec?.time
    ? instantFromLocal(localTimeSpec.date, localTimeSpec.time, zone)
    : null;
  if (recomputed) {
    const iso = recomputed.toISOString();
    for (const field of ['dueAt', 'remindAt'] as const) {
      const stated = field === 'dueAt' ? dueAt : remindAt;
      if (!stated) continue;
      const drift = Math.abs(Date.parse(stated) - recomputed.getTime());
      if (drift <= RECONCILE_TOLERANCE_MS) continue;
      // More than half a day apart is not an offset mistake. The wall clock
      // still wins, but the disagreement is reported rather than smoothed over.
      if (drift > CONTRADICTION_MS && !flags.includes('contradictory_time')) flags.push('contradictory_time');
      if (field === 'dueAt') dueAt = iso;
      else remindAt = iso;
    }
    // The model's own zone label is replaced by the device's, so the spec and
    // the instant describe the same clock.
    localTimeSpec = { ...localTimeSpec!, timezone: zone };
  } else if (dueAt || remindAt) {
    // No usable spec: derive one from whichever instant survived, so the review
    // screen has a local date and time to show without redoing zone math.
    const anchor = remindAt || dueAt;
    localTimeSpec = anchor ? localTimeSpecFor(new Date(Date.parse(anchor)), zone) : null;
  }

  return { dueAt, remindAt, localTimeSpec, timeEvidence: evidence, flags };
}

/**
 * Validate and normalise raw JSON (already parsed) from the LLM into a well-typed ExtractionResult.
 *
 * @param raw     - The parsed JSON object from the LLM response
 * @param rawText - The original user input (stamped into the result)
 *
 * @throws {ValidationError} when `type` is missing or unrecognisable
 */
export function validateExtractionResult(
  raw: unknown,
  rawText: string,
  context?: ExtractionContext,
): ExtractionResult {
  if (!isRecord(raw)) {
    throw new ValidationError('LLM output is not a JSON object');
  }
  const lowerRawText = rawText.toLowerCase();
  const rawTextHasNegatedReminder =
    /\b(don't|dont|do not|not|never|no need to|stop)\s+(remind|remember|bug|schedule|add|create|notify)\b/.test(lowerRawText) ||
    /\b(remind me|remember to|bug me)\s+not\b/.test(lowerRawText) ||
    /(?:תזכיר לי|תזכירי לי|ذكرني|ذكريني|remind me)\s+not\b/.test(lowerRawText) ||
    /(لا تذكرني|لا تذكريني|ما تذكرني|ما تذكريني|بلا تذكير|مش بدي تذكير|ما بدي تذكير|ما بديش تذكير|بطل تذكرني|بطلي تذكريني)/.test(lowerRawText) ||
    /(אל תזכיר לי|אל תזכירי לי|לא צריך להזכיר|תפסיק להזכיר|תפסיקי להזכיר)/.test(lowerRawText);

  // ── type ─────────────────────────────────────────────────────────────────
  const type = stringOrNull(raw['type']) as ExtractionType | null;
  if (!type || !VALID_TYPES.has(type)) {
    throw new ValidationError(`Invalid or missing extraction type: ${JSON.stringify(raw['type'])}`);
  }

  // ── ambiguityFlags / missingFields ─────────────────────────────────────
  const ambiguityFlags = (Array.isArray(raw['ambiguityFlags']) ? raw['ambiguityFlags'] : [])
    .map((f: unknown) => stringOrNull(f))
    .filter((f): f is AmbiguityFlag => f !== null && VALID_AMBIGUITY_FLAGS.has(f as AmbiguityFlag));
  if (rawTextHasNegatedReminder && !ambiguityFlags.includes('negated_request')) {
    ambiguityFlags.push('negated_request');
  }

  const missingFields = (Array.isArray(raw['missingFields']) ? raw['missingFields'] : [])
    .map((f: unknown) => stringOrNull(f))
    .filter((f): f is MissingField => f !== null && VALID_MISSING_FIELDS.has(f as MissingField));

  // ── confidence ────────────────────────────────────────────────────────
  const rawConf = isRecord(raw['confidence']) ? raw['confidence'] : {};
  let overallConfidence = clamp(rawConf['overall']);

  // Safety rule: negated requests must never auto-confirm
  if (ambiguityFlags.includes('negated_request')) {
    overallConfidence = Math.min(overallConfidence, 0.55);
  }

  // Assembled after the time is decided, below, so that a removed time cannot
  // be reported as a confident one.
  const statedTimeConfidence = clamp(rawConf['time']);

  // ── priority ──────────────────────────────────────────────────────────
  const rawPriority = isRecord(raw['priority']) ? raw['priority'] : {};
  const priorityLevelRaw = stringOrNull(rawPriority['level']);
  const priorityLevel = (priorityLevelRaw === 'low' || priorityLevelRaw === 'high')
    ? priorityLevelRaw
    : 'normal';
  const prioritySourceRaw = stringOrNull(rawPriority['source']);
  const prioritySource = (prioritySourceRaw === 'inferred' || prioritySourceRaw === 'user_explicit')
    ? prioritySourceRaw
    : 'default';

  let priority: ExtractionResult['priority'] = {
    level: priorityLevel,
    source: prioritySource,
    pressureAllowed: false,
    pressureImplied: boolOrDefault(rawPriority['pressureImplied'], false),
  };

  // ── flexibility ───────────────────────────────────────────────────────
  const flexibility: ExtractionResult['flexibility'] =
    raw['flexibility'] === 'soft' ? 'soft' : 'movable';

  // ── category ──────────────────────────────────────────────────────────
  // Shape only: a name the catalog still has, or nothing. The floor and the
  // user's own choice of categories are applied later, by `resolveCategory`
  // (#415). A name the model invented takes its confidence with it, so no
  // later layer can see a 1.0 next to a category that was thrown away.
  const category = isCommitmentCategory(raw['category']) ? raw['category'] : null;
  const categoryConfidence = category === null ? 0 : clamp(raw['categoryConfidence']);

  // ── time ──────────────────────────────────────────────────────────────
  // Deterministic, and after everything else: the model's instant is an input
  // here, not the answer (#162).
  const time = reconcileLocalTimeSpec(
    {
      dueAt: isoStringOrNull(raw['dueAt'], 'dueAt'),
      remindAt: isoStringOrNull(raw['remindAt'], 'remindAt'),
      localTimeSpec: localTimeSpecFrom(raw['localTimeSpec']),
    },
    rawText,
    context,
  );
  // The model's date is never moved here (controller ruling, L4 fix round 1):
  // an override built on a word list moved correct dates — "the first report"
  // became a Sunday. The same tokenizer only *marks* a date that came from a
  // whole-word weekday and nothing else, so the review card can say it was
  // guessed and offer the week after.
  const dateInferred = modelDateIsWeekdayGuess(rawText, time.localTimeSpec?.date);
  for (const flag of time.flags) {
    if (!ambiguityFlags.includes(flag)) ambiguityFlags.push(flag);
  }

  // The rules fallback for the prompt's appointment guidance (L4). A model that
  // left a fixed appointment at its default is raised — as a guess, so the
  // review card still says so. A level the user stated, or a low the model
  // read, is theirs and is not touched.
  //
  // The day is the text's as well as the model's (CL1, A3). Gemini answered
  // «سجّل موعد دكتور يوم الأحد» with `localTimeSpec: null` — no day at all —
  // and a doctor with no fixed day is not raised, so the Sunday the user said
  // was lost to the priority too. Only whether a day is named is read here;
  // the model's date itself is still never moved.
  const textNamesDay = readWeekdayReference(rawText) !== null || namesExplicitDate(rawText);
  if (
    (type === 'task' || type === 'follow_up')
    && priority.level === 'normal'
    && priority.source !== 'user_explicit'
    && isFixedAppointment(rawText, { hasDay: Boolean(time.localTimeSpec?.date) || textNamesDay, hasClock: Boolean(time.localTimeSpec?.time) })
  ) {
    priority = { ...priority, level: 'high', source: 'inferred' };
  }
  if (!time.remindAt && !time.dueAt && !missingFields.includes('time')) missingFields.push('time');

  const confidence: ExtractionResult['confidence'] = {
    // A capture whose time was removed, or kept only as an unmarked half of the
    // day, must not read as certain — the disposition policy and the review
    // screen both decide from these numbers.
    overall: time.flags.includes('vague_time') ? Math.min(overallConfidence, 0.62) : overallConfidence,
    type: clamp(rawConf['type']),
    action: clamp(rawConf['action']),
    time: !time.dueAt && !time.remindAt
      ? Math.min(statedTimeConfidence, 0.1)
      : time.timeEvidence === 'clock_marker'
        ? Math.min(statedTimeConfidence, 0.7)
        : statedTimeConfidence,
    priority: clamp(rawConf['priority']),
  };

  // ── assemble ──────────────────────────────────────────────────────────
  return {
    type,
    // The model may keep «سجّل» in its title as the rules path used to; the
    // same function takes it off both (L4, fix round 2).
    // A task the model titled but gave no separate `action` — «عندي تمرين
    // بالجيم … الساعة 7 المسا» came back `action: null`, title «تمرين بالجيم»
    // — is not missing what to do: the title says it. Left null, the policy
    // read the item as incomplete, dropped the 19:00 the user said and asked
    // for a time (CL1). The rules extractor has always set both from one
    // string.
    action: commandFree(stringOrNull(raw['action']))
      ?? (type === 'task' || type === 'follow_up' ? commandFree(stringOrNull(raw['title'])) : null),
    title: commandFree(stringOrNull(raw['title'])),
    person: stringOrNull(raw['person']),
    dueAt: time.dueAt,
    remindAt: time.remindAt,
    localTimeSpec: time.localTimeSpec,
    timeEvidence: time.timeEvidence,
    dateInferred,
    // Read from the text, like the time itself: the model is not asked.
    timeAnchor: timeAnchorOf(rawText),
    priority,
    flexibility,
    category,
    categoryConfidence,
    confidence,
    missingFields,
    ambiguityFlags,
    explicitReminderRequest: rawTextHasNegatedReminder ? false : boolOrDefault(raw['explicitReminderRequest'], false),
    explicitPressureRequest: boolOrDefault(raw['explicitPressureRequest'], false),
    rawText,
    parserVersion: PARSER_VERSION,
  };
}
