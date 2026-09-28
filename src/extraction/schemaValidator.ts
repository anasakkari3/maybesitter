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
  lastDayOfMonth,
  localTimeSpecFor,
  monthEndDay,
  monthEndIsNotTheDay,
  namesDay,
  namesOtherDayThanToday,
  namesTodayOnly,
  namesTwelveInTheEvening,
  readPeriodEndDeadline,
  relativeDayIsUnsettled,
  relativeDayOffset,
  thisMonthEndWords,
  timeAnchorOf,
  timeOfDayEvidence,
  unsettledRelativeDayPhrase,
} from './timeLexicon';
import { isCommitmentCategory } from '../contracts/v1/categoryContracts';
import { modelDateIsWeekdayGuess, namesCalendarDate, namesExplicitDate, readWeekdayReference, resolveWeekdayDate } from './weekdayLexicon';
import { isFixedAppointment, statedObligation } from './priorityLexicon';
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
/**
 * A title the model cut before this month's end, when the reading did not use
 * those words as the deadline (FY1 N6). «أحضّر تقرير آخر الشهر» is the
 * month-end report — FX3 keeps the phrase in the rules title — and the model
 * titled it «أحضّر تقرير». Put back only where they were: the model's title,
 * as the person wrote it, followed directly by the words.
 */
function withMonthEndWords(title: string | null, rawText: string, words: string | null): string | null {
  if (!title || !words || title.includes(words)) return title;
  const at = rawText.indexOf(title);
  if (at < 0) return title;
  const after = rawText.slice(at + title.length);
  const lead = /^\s+/.exec(after)?.[0] ?? '';
  return lead && after.slice(lead.length).startsWith(words) ? `${title}${lead}${words}` : title;
}

/*
 * Who it is with, when the model's title stopped just before it (closure UAT
 * round 4, N16). «…والخميس الساعة 6 المسا عندي عشا مع العيلة» came back from
 * Gemini titled «عندي عشا», and the dinner was saved without the family —
 * the prompt's own example «عندي دكتور» is two words. The company is the
 * person's words, as «آخر الشهر» is (FY1 N6): put back only where it was —
 * the model's title as the person wrote it, followed directly by «مع»/"with"/
 * «עם» — up to three words, stopping at a time or day word (`timeOfDayEvidence`
 * reads both), a number, a preposition, or another «مع»/"with"/«עם», so the
 * title never ends on one (POLISH-CAPTURE review, M1). Only company: «مع
 * السلامة», «مع إني…», "with love", "with it", «עם זאת» are not who it is
 * with, and nothing is put back for them.
 */
const COMPANION_MARKER = new RegExp('^(\\s+)(مع|with|עם)(?=\\s)', 'i');
const COMPANION_TRAILING_PUNCTUATION = /[،,.;!?؟:]+$/;
const COMPANION_NUMBER = /^[0-9٠-٩]|^ב-?[0-9]/;
const COMPANION_STOP = new Set([
  'on', 'at', 'by', 'in', 'before', 'after', 'for', 'to', 'from', 'until', 'and', 'then',
  'يوم', 'نهار', 'الساعة', 'الساعه', 'قبل', 'بعد', 'عند', 'على', 'ع', 'في', 'لحد', 'حتى', 'من',
  'ביום', 'בשעה', 'לפני', 'אחרי', 'עד', 'ב', 'ו',
  'مع', 'with', 'עם',
]);
/** What follows «مع»/"with"/«עם» without being company. */
const NOT_COMPANY = new Set([
  'السلامة', 'السلامه', 'إني', 'اني', 'إنه', 'انه', 'إنو', 'انو', 'إنها', 'انها', 'هيك', 'ذلك', 'هذا', 'هاد', 'العلم',
  'love', 'it', 'that', 'this', 'regards', 'pleasure', 'thanks', 'care',
  'זאת', 'זה',
]);
/** An Arabic word that starts with a preposition and the article: «عالبحر», «بالبيت», «للسوق». */
const PREPOSITIONAL_WORD = /^(?:عال|بال|لل)/;
function withCompanion(title: string | null, rawText: string): string | null {
  if (!title) return title;
  const at = rawText.indexOf(title);
  if (at < 0) return title;
  const marker = COMPANION_MARKER.exec(rawText.slice(at + title.length));
  if (!marker) return title;
  const rest = rawText.slice(at + title.length + marker[0].length);
  const words: string[] = [];
  const first = rest.split(/\s+/).find(Boolean)?.replace(COMPANION_TRAILING_PUNCTUATION, '').toLowerCase();
  if (!first || NOT_COMPANY.has(first)) return title;
  for (const word of rest.split(/\s+/).filter(Boolean)) {
    const bare = word.replace(COMPANION_TRAILING_PUNCTUATION, '');
    if (!bare || COMPANION_STOP.has(bare.toLowerCase()) || timeOfDayEvidence(bare) !== 'none' || COMPANION_NUMBER.test(bare) || PREPOSITIONAL_WORD.test(bare)) break;
    words.push(bare);
    if (bare !== word || words.length === 3) break;
  }
  return words.length > 0 ? `${title}${marker[1]}${marker[2]} ${words.join(' ')}` : title;
}

/*
 * A day the words rule out or leave open, when the model's title left it out
 * (closure UAT round 6, shot 506). «بدي أتصل بسامي بس مش بكرا» came back from
 * Gemini titled «أتصل بسامي»: the item was rightly asked with no day, but the
 * review card showed the call without its limit. The phrase is the person's
 * (review M2 ruling): the title keeps it verbatim, as the rules path does
 * (`stripTiming`). Only the title changes; no day or time is read from it.
 * Where the model's title is the person's words next to the phrase, with at
 * most a connector between («بس», "but", «אבל», a comma), the stretch they
 * cover is taken as written; otherwise the phrase is put on the side it was
 * said.
 */
const UNSETTLED_TITLE_GAP = new RegExp('^[\\s،,;:.\\-–—]*(?:(?:و?بس|و?لكن|but|and|yet|אבל|ו)[\\s،,]*)?$', 'iu');
function withUnsettledDay(title: string | null, rawText: string): string | null {
  if (!title) return title;
  const phrase = unsettledRelativeDayPhrase(rawText);
  if (!phrase || title.includes(phrase.text)) return title;
  const phraseEnd = phrase.index + phrase.text.length;
  const at = rawText.indexOf(title);
  if (at < 0) return `${title} ${phrase.text}`;
  const titleEnd = at + title.length;
  if (phrase.index >= titleEnd) {
    return UNSETTLED_TITLE_GAP.test(rawText.slice(titleEnd, phrase.index))
      ? rawText.slice(at, phraseEnd)
      : `${title} ${phrase.text}`;
  }
  if (phraseEnd <= at) {
    return UNSETTLED_TITLE_GAP.test(rawText.slice(phraseEnd, at))
      ? rawText.slice(phrase.index, titleEnd)
      : `${phrase.text} ${title}`;
  }
  // The title holds part of the phrase («أتصل بسامي بس مش»): the whole stretch.
  return rawText.slice(Math.min(at, phrase.index), Math.max(titleEnd, phraseEnd));
}

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

/** A `YYYY-MM-DD` date `days` days on (or back). */
function shiftLocalDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The calendar day after a local `YYYY-MM-DD`. */
function nextLocalDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
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

  // «لازم», "have to", «חייב» in the person's own words is their Must (FX3,
  // closure UAT 2026-09-27). Gemini answered «بكرا لازم أسلّم التقرير» with its
  // default — the prompt said only "urgent" or "important" counts — so the
  // review card showed «يُفضّل» for something the person had called «لازم».
  // `rawText` is this clause alone (batch answers are validated per clause), so
  // the word never reaches a neighbouring commitment. A low the model read is
  // left alone: the same clause said something softer too.
  if (priority.level !== 'low' && statedObligation(rawText) === 'must') {
    priority = { ...priority, level: 'high', source: 'user_explicit' };
  }

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
  let time = reconcileLocalTimeSpec(
    {
      dueAt: isoStringOrNull(raw['dueAt'], 'dueAt'),
      remindAt: isoStringOrNull(raw['remindAt'], 'remindAt'),
      localTimeSpec: localTimeSpecFrom(raw['localTimeSpec']),
    },
    rawText,
    context,
  );
  // «الساعة 12 المسا» said in the capture (POLISH-CAPTURE review, M7): the
  // model's 12:00 or 00:00 is a guess at an hour nobody can read. Its day is
  // kept and the hour is asked, as on the rules path.
  if (namesTwelveInTheEvening(rawText) && (time.localTimeSpec?.time || time.dueAt || time.remindAt)) {
    const zone = context?.timezone || time.localTimeSpec?.timezone || 'UTC';
    const instant = time.dueAt ?? time.remindAt;
    const date = time.localTimeSpec?.date ?? (instant ? localTimeSpecFor(new Date(Date.parse(instant)), zone)?.date ?? null : null);
    time = {
      ...time,
      dueAt: null,
      remindAt: null,
      localTimeSpec: date ? { date, time: null, timezone: zone } : null,
      flags: time.flags.includes('vague_time') ? time.flags : [...time.flags, 'vague_time'],
    };
  }
  // The model's date is never moved here (controller ruling, L4 fix round 1):
  // an override built on a word list moved correct dates — "the first report"
  // became a Sunday. The same tokenizer only *marks* a date that came from a
  // whole-word weekday and nothing else, so the review card can say it was
  // guessed and offer the week after.
  let dateInferred = modelDateIsWeekdayGuess(rawText, time.localTimeSpec?.date);
  // The model named no day at all for a sentence that names a weekday (CL1,
  // round 1). Gemini answered «سجّل موعد دكتور يوم الأحد» with
  // `localTimeSpec: null`, so the review card had no Sunday to show and the
  // time question could not name it. The day is filled by the rule the rules
  // path uses (`resolveWeekdayDate`: the nearest one that is not today, a week
  // later only for "the one after") and marked a guess. A date the model *did*
  // return is never touched — only an absent one is filled — and a sentence
  // that states its date some other way is left to the model.
  if (!time.localTimeSpec?.date && context?.now && !namesExplicitDate(rawText)) {
    const zone = context.timezone || 'UTC';
    const weekday = resolveWeekdayDate(rawText, context.now, zone);
    if (weekday) {
      time = { ...time, localTimeSpec: { date: weekday.date, time: null, timezone: zone } };
      dateInferred = weekday.inferred;
    }
  }
  // The words say today and no other day, and the model's day is tomorrow
  // (closure UAT round 3, FZ1 N10). At 03:22 on Monday, «اليوم الساعة 2 بالليل
  // لازم أبعت الإيميل للمدير» came back one run in five as Tuesday 02:00, and
  // was proposed, settled, as «بكرا · 02:00»: a later reading nobody said,
  // picked for the person (CL1: never). The words' day wins — and nothing is
  // settled on it: the model's hour is dropped, so the item is asked for an
  // hour on today, like a passed hour (FZ1 review, I1).
  //
  // Narrow on purpose (FZ1 review, I1): only a model day of exactly tomorrow
  // (the passed or night hour rolled over), and never when the words name the
  // day some other way — «يوم 5», «آخر الشهر», «أول الشهر», «مش اليوم», the
  // weekend, the feast — which the model reads rightly.
  if (
    context?.now && time.localTimeSpec?.date && namesTodayOnly(rawText)
    && !readWeekdayReference(rawText) && !namesCalendarDate(rawText) && !namesOtherDayThanToday(rawText)
  ) {
    const zone = context.timezone || 'UTC';
    const today = localTimeSpecFor(context.now, zone)?.date ?? null;
    const tomorrow = today ? nextLocalDate(today) : null;
    if (today && time.localTimeSpec.date === tomorrow) {
      time = { ...time, dueAt: null, remindAt: null, localTimeSpec: { date: today, time: null, timezone: zone } };
      dateInferred = false;
    }
  }
  // «قبل آخر الشهر» (FX3): a deadline on the month's last day, all day. Gemini
  // answered it with no day at all in the UAT, and with the 30th plus a 23:59
  // nobody said here — the hour is gone above, and the day would then have
  // been asked an hour for, or lost with a "no time" answer. Only when the
  // sentence names no time of day.
  //
  // And only when the model's day *is* the month's last day on the person's
  // clock, or it gave none (review I-2). The L4 ruling never moves a model's
  // date, and settling a different one — the 31st of next month, the 29th, or
  // the UTC month's end the prompt's reference instant suggests at 00:30 on the
  // 1st — as a firm deadline would be worse than asking. Those keep the
  // pre-FX3 reading: the model's day, and the hour asked.
  let allDay = false;
  const zone = context?.timezone || 'UTC';
  const monthLastDay = context?.now ? lastDayOfMonth(context.now, zone) : null;
  // The person's words say this month's end, and name no other day: the words
  // win over the model (controller ruling, FY1 N6). Gemini answered «أحضّر
  // تقرير آخر الشهر» on 27 Sep with 31 October, and the card asked «أي ساعة
  // يوم السبت، 31 أكتوبر؟». A model day after this month's last day on the
  // person's clock is discarded, and the item then settles or asks as FX3
  // decides below; an earlier one is FX3's to keep (its 1st-of-month edge
  // included).
  const monthEndWords = thisMonthEndWords(rawText);
  // Only a day *after* this month's end is the N6 defect (review I2): an
  // earlier model day may be the words' own offset — «قبل آخر الشهر بأسبوع»,
  // "two days before the end of the month" — and one after it may be, too,
  // when the words say so («بعد آخر الشهر بيومين», «סוף חודש אוקטובר»).
  if (
    monthEndWords && monthLastDay && time.localTimeSpec?.date && time.localTimeSpec.date > monthLastDay
    && !monthEndIsNotTheDay(rawText)
    && !namesDay(rawText) && !namesExplicitDate(rawText)
  ) {
    time = { ...time, dueAt: null, remindAt: null, localTimeSpec: null };
    dateInferred = false;
  }
  // The day the words' month end means on the person's clock, counted back or
  // on when they carry an offset (FZ1 round 2): «قبل آخر الشهر بأسبوع» is the
  // 23rd, not the 30th FX3 settled. A model 30th under such an offset is the
  // month's end the words moved away from, and gives way to it.
  const wordsDay = context?.now ? monthEndDay(rawText, context.now, zone) : null;
  // A counted day before this month's end is the words' own, whatever day the
  // model gave (closure UAT round 4, N15). At 06:58 on Monday 28 Sep, «أخلص
  // التقرير قبل آخر الشهر بيومين» — the 28th, today — came back from Gemini
  // as 29 or 30 October (4 of 4), and FY1 left any model day under an offset
  // to the model: a next-month reading nobody said, picked for the person.
  // The words win; a stated hour the model read goes with them. Not when the
  // words name a day of their own as well — that one is the model's to read.
  const countedBefore = wordsDay?.side === 'before' && !namesDay(rawText) && !namesExplicitDate(rawText) ? wordsDay.date : null;
  if (countedBefore && time.localTimeSpec?.date && time.localTimeSpec.date !== countedBefore) {
    const stated = forbidsResolvedTime(rawText) ? null : time.localTimeSpec.time;
    const instant = stated ? instantFromLocal(countedBefore, stated, zone) : null;
    time = {
      ...time,
      dueAt: instant ? instant.toISOString() : null,
      remindAt: instant && time.remindAt ? instant.toISOString() : null,
      localTimeSpec: { date: countedBefore, time: instant ? stated : null, timezone: zone },
    };
    dateInferred = false;
  }
  const modelDay = time.localTimeSpec?.date ?? null;
  const deadlineDay = wordsDay && wordsDay.side !== 'after' ? wordsDay.date : null;
  const today = context?.now ? localTimeSpecFor(context.now, zone)?.date ?? null : null;
  // A day the words name beside «قبل آخر الشهر» — «بدي أخلص تقرير اليوم قبل
  // آخر الشهر», «…بكرا قبل آخر الشهر», «…يوم الخميس قبل آخر الشهر» (FZ1
  // review, N-M3). The rules path has always read the named day (the month's
  // end only "when nothing else in the sentence named a day"), and asked the
  // hour; a model that gave no day, or the month's end, was settled on the
  // 30th here — the later reading, picked silently. Both engines now read the
  // named day and ask.
  const namedOffset = relativeDayOffset(rawText);
  const namedDay = today && namedOffset !== null
    ? shiftLocalDate(today, namedOffset)
    : context?.now ? resolveWeekdayDate(rawText, context.now, zone) : null;
  const namedDate = typeof namedDay === 'string' ? namedDay : namedDay?.date ?? null;
  if (
    namedDate && wordsDay?.side === 'end' && forbidsResolvedTime(rawText) && readPeriodEndDeadline(rawText) === 'month'
    && (modelDay === null || modelDay === monthLastDay)
  ) {
    time = { ...time, dueAt: null, remindAt: null, localTimeSpec: { date: namedDate, time: null, timezone: zone } };
    dateInferred = typeof namedDay === 'string' ? false : namedDay?.inferred ?? false;
  } else if (
    countedBefore && countedBefore === today && forbidsResolvedTime(rawText)
    && (modelDay === null || modelDay === countedBefore)
  ) {
    // The counted day is today (N15): that day, and the hour asked — not an
    // all-day limit whose midnight has already gone. (A counted day that has
    // gone takes the deadline below, which the guard refuses as past, and the
    // boundary asks with no day: never next month.)
    time = { ...time, dueAt: null, remindAt: null, localTimeSpec: { date: countedBefore, time: null, timezone: zone } };
    dateInferred = false;
  } else if (
    deadlineDay && monthLastDay && forbidsResolvedTime(rawText) && readPeriodEndDeadline(rawText) === 'month'
    && (modelDay === null || modelDay === monthLastDay || modelDay === deadlineDay)
  ) {
    const date = deadlineDay;
    const midnight = instantFromLocal(date, '00:00', zone);
    if (midnight) {
      allDay = true;
      dateInferred = false;
      time = {
        ...time,
        dueAt: midnight.toISOString(),
        remindAt: null,
        localTimeSpec: { date, time: null, timezone: zone },
        timeEvidence: 'day_only',
        flags: time.flags.filter((flag) => flag !== 'vague_time'),
      };
      for (let index = ambiguityFlags.length - 1; index >= 0; index -= 1) {
        if (ambiguityFlags[index] === 'vague_time') ambiguityFlags.splice(index, 1);
      }
      for (let index = missingFields.length - 1; index >= 0; index -= 1) {
        if (missingFields[index] === 'time') missingFields.splice(index, 1);
      }
    }
  }
  // This month's end in the person's words, and no day at all from the model
  // — it gave none, or FY1 discarded a later one (closure UAT round 3, FZ1
  // N6). «أحضّر تقرير آخر الشهر» at 03:40 on Monday kept its title and got
  // no day: Gemini answered `localTimeSpec: null` (twice, recorded). The
  // words win for this month's end (controller ruling): the day is this
  // month's last on the person's clock, the hour is asked, and the day is
  // marked a guess — it is read from a name for the report, not said as a
  // date. Only with no time of day and no other day in the words, and never
  // with an offset or another month (FY1 review, I2).
  // A counted offset after it («بعد آخر الشهر بيومين») is the day counted
  // to, said rather than guessed, with or without an hour (FZ1 round 2).
  if (
    !time.localTimeSpec?.date && !time.dueAt && !time.remindAt
    && wordsDay && (wordsDay.side !== 'end' || forbidsResolvedTime(rawText))
    && !namesDay(rawText) && !namesExplicitDate(rawText)
  ) {
    time = { ...time, localTimeSpec: { date: wordsDay.date, time: null, timezone: zone } };
    dateInferred = wordsDay.side === 'end';
  }
  // The model named no day for a sentence that names today, tomorrow or the
  // day after (final UAT, N19). At 10:04 on Monday, «سجّل موعد دكتور اليوم»
  // reached the card as «موعد دكتور · بدون وقت» asking «أي وقت بناسبك؟» — no
  // day — while «عندي موعد دكتور اليوم» a minute later kept «اليوم»: the
  // model's variance, not the imperative (the rules path keeps the day for
  // both). The words' day fills an absent one, as a weekday's does above and
  // as the rules path reads it (`relativeDayOffset`), said and not guessed.
  // Only an absent day: a model day is never moved here (L4). Not when the
  // words name today only to rule it out («مش اليوم», "not today"), rule out
  // or leave open any relative day («مش بكرا», «اليوم أو بكرا» — review M2),
  // nor beside a date or a weekday of their own.
  if (
    !time.localTimeSpec?.date && !time.dueAt && !time.remindAt && today
    && !namesCalendarDate(rawText) && !readWeekdayReference(rawText)
  ) {
    const offset = relativeDayOffset(rawText);
    if (offset !== null && !(offset === 0 && namesOtherDayThanToday(rawText)) && !relativeDayIsUnsettled(rawText)) {
      time = { ...time, localTimeSpec: { date: shiftLocalDate(today, offset), time: null, timezone: zone } };
      dateInferred = false;
    }
  }
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
    title: withUnsettledDay(withCompanion(allDay ? commandFree(stringOrNull(raw['title'])) : withMonthEndWords(commandFree(stringOrNull(raw['title'])), rawText, monthEndWords), rawText), rawText),
    person: stringOrNull(raw['person']),
    dueAt: time.dueAt,
    remindAt: time.remindAt,
    localTimeSpec: time.localTimeSpec,
    timeEvidence: time.timeEvidence,
    dateInferred,
    // Read from the text, like the time itself: the model is not asked. The
    // month's end is always a limit (FX3).
    timeAnchor: allDay ? 'deadline' : timeAnchorOf(rawText),
    ...(allDay ? { allDay: true } : {}),
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
