import type { ExtractionContext, ExtractionResult, LocalTimeSpec } from './extractionTypes';
import { classifyMessageKind, createsNothing } from './messageKind';
import {
  CLOCK_PATTERN_SOURCES,
  RANGE_PATTERN_SOURCES,
  dayPartHour,
  localTimeSpecFor,
  normalizeArabicDigits,
  normalizeSpokenArabicHours,
  normalizeSpokenHebrewHours,
  timeOfDayEvidence,
  type TimeEvidence,
} from './timeLexicon';
import {
  FOLLOWING_WEEK_STRIP_SOURCES,
  WEEKDAY_MENTION_SOURCES,
  daysUntilWeekday,
  readWeekdayReference,
} from './weekdayLexicon';
import { isFixedAppointment } from './priorityLexicon';
import { stripCaptureCommand } from './captureCommand';

export { CLOCK_PATTERN_SOURCES, RANGE_PATTERN_SOURCES } from './timeLexicon';

const PARSER_VERSION = 'rule-v1-core';

/**
 * The rule-based path never guesses a category (#415).
 *
 * The tempting fix when the model is unavailable is a keyword table — "meeting"
 * is work, "doctor" is health. It is wrong in Arabic, wrong in Hebrew, wrong
 * for "meeting the school about Lina", and worst of all it is *confidently*
 * wrong: it produces a category the rest of the app cannot tell apart from one
 * the model actually reasoned about. The user would then find commitments
 * filed under a category nobody chose, in the one situation — the model being
 * down — where they have least reason to expect it.
 *
 * `null` costs the user nothing: an uncategorised commitment still appears
 * under "All", which is where everyone who has not turned the split on is
 * looking anyway.
 */
const NO_CATEGORY = { category: null, categoryConfidence: 0 } as const;
const INFORMATIONAL_RE =
  /\b(waiting on|for your information|fyi|just so you know|asked me about|told me about)\b|(سألتني|سألني|تسألني|مستني|مستنية|بانتظار|ينتظر|تنتظر|قالت لي|قال لي)|(מחכה|מחכים|שאל אותי|שאלה אותי|ביקש ממני)|(i|we) had a (nice|great|good|bad|tiring|long|busy|rough) (day|week|morning|afternoon|evening|night)\b/i;

function setTime(date: Date, hour: number, minute = 0): Date {
  const next = new Date(date);
  next.setHours(hour, minute, 0, 0);
  return next;
}

/* ── Timezone-aware date math ──────────────────────────────────────
 * The extractor receives a `timezone` in its context (e.g. 'UTC',
 * 'Asia/Jerusalem'). Relative phrases ("tomorrow at 10am") must resolve
 * to the same absolute instant regardless of the host machine's timezone.
 * These helpers do wall-clock math in the target timezone and convert back
 * to UTC. When no timezone is supplied we fall back to the host timezone to
 * preserve legacy behavior. DST transitions are handled with a two-pass
 * offset refinement. */

function tzOffsetMs(date: Date, timeZone: string): number {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return 0;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(date);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 3_600 + Number(match[3]) * 60) * 1_000;
}

function wallClockParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const offset = tzOffsetMs(date, timeZone);
  const wall = new Date(date.getTime() + offset);
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth(),
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
  };
}

function fromWallClock(parts: { year: number; month: number; day: number; hour: number; minute: number; second: number }, timeZone: string): Date {
  const utcGuess = new Date(Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second));
  const offset = tzOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset);
}

function addDaysTz(date: Date, days: number, timeZone: string): Date {
  const parts = wallClockParts(date, timeZone);
  return fromWallClock({ ...parts, day: parts.day + days }, timeZone);
}

function setTimeTz(date: Date, hour: number, minute: number, timeZone: string): Date {
  const parts = wallClockParts(date, timeZone);
  return fromWallClock({ ...parts, hour, minute, second: 0 }, timeZone);
}

/**
 * The date a weekday name means, by the rule in `weekdayLexicon.ts`: the
 * nearest one that is not today, a week later only when the text says "the one
 * after", and today only when the text says today.
 */
function weekdayTargetTz(from: Date, currentText: string, timeZone: string): { date: Date; daysAhead: number } | null {
  const reference = readWeekdayReference(currentText);
  if (!reference) return null;
  const parts = wallClockParts(from, timeZone);
  const currentWeekday = new Date(Date.UTC(parts.year, parts.month, parts.day)).getUTCDay();
  const daysAhead = daysUntilWeekday(currentWeekday, reference);
  return { date: addDaysTz(from, daysAhead, timeZone), daysAhead };
}

function resolveTimezone(context: ExtractionContext): string {
  return context.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function parseClock(raw: string): { hour: number; minute: number } | null {
  const normalized = normalizeSpokenHebrewHours(normalizeSpokenArabicHours(normalizeArabicDigits(raw))).toLowerCase();
  const explicit =
    normalized.match(/(?:\b(?:at|by|around)\b|الساعة|الساعه|عند|على|בשעה|שעה|בסביבות(?:\s+ה?שעה)?|סביב(?:\s+ה?שעה)?|לקראת(?:\s+ה?שעה)?|עד(?:\s+ה?שעה)?|[בס]-?)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|صباحا|صباحاً|الصبح|ص|مساء|مساءً|المسا|المساء|بالليل|م|בבוקר|בוקר|בצהריים|צהריים|אחרי הצהריים|אחה"צ|בערב|ערב|בלילה|לילה)?(?=$|[\s,.،])/) ||
    normalized.match(/\b(\d{1,2}):(\d{2})(?=$|[\s,.،])/) ||
    normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|صباحا|صباحاً|الصبح|ص|مساء|مساءً|المسا|المساء|بالليل|م|בבוקר|בוקר|בצהריים|צהריים|אחרי הצהריים|אחה"צ|בערב|ערב|בלילה|לילה)(?=$|[\s,.،])/);
  if (!explicit) return null;
  let hour = Number(explicit[1]);
  const minute = explicit[2] ? Number(explicit[2]) : 0;
  const period = explicit[3] || '';
  if (hour < 1 || hour > 23 || minute < 0 || minute > 59) return null;
  if (/(pm|مساء|المسا|المساء|بالليل|م|בערב|ערב|בלילה|לילה|אחרי הצהריים|אחה"צ|בצהריים|צהריים)/.test(period) && hour < 12) hour += 12;
  if (/(am|صباح|الصبح|ص|בבוקר|בוקר|בלילה|לילה)/.test(period) && hour === 12) hour = 0;
  return { hour, minute };
}

interface ParsedTime {
  dueAt: string | null;
  remindAt: string | null;
  confidence: number;
  /** Why the time was believed, or why there is none. */
  evidence: TimeEvidence;
  localTimeSpec: LocalTimeSpec | null;
  /** The day came from a weekday name alone, so it is the product's guess. */
  dateInferred: boolean;
}

function parseDateTime(raw: string, context: ExtractionContext): ParsedTime {
  const lower = raw.toLowerCase();
  const now = context.now;
  const tz = resolveTimezone(context);
  const clock = parseClock(raw);
  let targetDate: Date | null = null;
  let timeConfidence = 0;
  let dateInferred = false;

  if (
    /\btoday\b/.test(lower) ||
    /\btonight\b/.test(lower) ||
    /(اليوم|النهارده|اليومه|الليلة|الليله)/.test(lower) ||
    /(?:^|[\s,.،])(היום|הערב|הלילה)(?=$|[\s,.،])/.test(lower)
  ) {
    targetDate = new Date(now);
    timeConfidence = 0.85;
  }
  if (
    /\b(?:tomorrow|tmrw|tmr|tomorow)\b/.test(lower) ||
    /(بكرا|بكرة|بكره|باچر|باكر|غدا|غداً)/.test(lower) ||
    /(?:^|[\s,.،])מחר(?=$|[\s,.،])/.test(lower)
  ) {
    targetDate = addDaysTz(now, 1, tz);
    timeConfidence = 0.9;
  }
  if (
    /\b(?:after tomorrow|day after tomorrow|after tmrw)\b/.test(lower) ||
    /(بعد بكرا|بعد بكرة|بعد بكره|بعد غد|بعد غداً)/.test(lower) ||
    /(?:^|[\s,.،])מחרתיים(?=$|[\s,.،])/.test(lower)
  ) {
    targetDate = addDaysTz(now, 2, tz);
    timeConfidence = 0.9;
  }

  const weekday = weekdayTargetTz(now, raw, tz);
  if (weekday) {
    targetDate = weekday.date;
    timeConfidence = 0.88;
    // Every weekday day is a guess (rule 4) unless the text said today. That
    // includes a sentence that also typed a date this parser cannot read
    // ("the 4th"): the Sunday picked here may not be it, and saying so is the
    // honest answer.
    dateInferred = weekday.daysAhead !== 0;
  }

  if (!targetDate && clock) {
    targetDate = new Date(now);
    timeConfidence = 0.72;
  }

  const evidence = timeOfDayEvidence(raw);

  if (!targetDate) {
    return { dueAt: null, remindAt: null, confidence: 0.1, evidence, localTimeSpec: null, dateInferred: false };
  }

  // The hour has to come from the sentence. It used to come from `?? 18`, so
  // "remind me tomorrow" — a date and nothing else — resolved to six in the
  // evening at time-confidence 0.9 and overall 0.9, with no ambiguity flag.
  // That is high enough to auto-confirm, so the product silently scheduled an
  // hour the user never said and never asked about it. A caller that sets
  // `defaultReminderHour` has *chosen* a default and still gets one; its
  // absence now means "no time stated" rather than "six".
  const daypart = dayPartHour(raw);
  let hour: number;
  let minute = 0;
  if (clock) {
    hour = clock.hour;
    minute = clock.minute;
    // «الساعة 3 العصر» is three in the *afternoon*. `parseClock` only reads
    // مساء/بالليل/am/pm as a meridiem, so العصر — and English "at 8 tonight" —
    // left the hour in the morning half and scheduled 03:00. The part-of-day
    // word is exactly the meridiem the sentence gave, so it is used as one.
    // Only when there was no explicit AM/PM to begin with: `ampm` and `hhmm`
    // have already said which half of the day they mean.
    if (evidence === 'daypart' && daypart !== null && daypart >= 12 && hour >= 1 && hour <= 11) {
      hour += 12;
    }
    timeConfidence = Math.max(timeConfidence, 0.95);
  } else if (daypart !== null) {
    hour = daypart;
  } else if (context.defaultReminderHour !== undefined) {
    hour = context.defaultReminderHour;
  } else {
    // The day parsed; the hour was never stated. Report exactly that, so the
    // review screen can show "Sunday" and the clarification step can ask for
    // the hour alone (#164, #165).
    const day = localTimeSpecFor(targetDate, tz);
    return {
      dueAt: null,
      remindAt: null,
      confidence: 0.1,
      evidence,
      localTimeSpec: day ? { ...day, time: null } : null,
      dateInferred,
    };
  }

  const withTime = setTimeTz(targetDate, hour, minute, tz);
  // A clock time with no meridiem is the user's number and the product's guess
  // at which half of the day it belongs to. It is kept, and it is named, so the
  // review screen and the clarification question can both see that it is soft.
  const confidence = evidence === 'clock_marker' ? Math.min(timeConfidence, 0.7) : timeConfidence;
  return {
    dueAt: withTime.toISOString(),
    remindAt: withTime.toISOString(),
    confidence,
    evidence,
    localTimeSpec: localTimeSpecFor(withTime, tz),
    dateInferred,
  };
}

function stripTiming(text: string): string {
  // Rewrite «الساعة تسعة» to «الساعة 9» and «בשעה תשע» to «בשעה 9» first, so
  // the clock patterns below strip a spoken hour out of the title exactly as
  // they strip a typed one.
  let stripped = normalizeSpokenHebrewHours(normalizeSpokenArabicHours(text));
  // "The one after" phrases whole, before the bare day names below take their
  // weekday and leave «اللي بعد الجاي» behind in the title.
  for (const source of FOLLOWING_WEEK_STRIP_SOURCES) {
    stripped = stripped.replace(new RegExp(source, 'giu'), ' ');
  }
  stripped = stripped
    .replace(/\b(after tomorrow|day after tomorrow|after tmrw|today|tomorrow|tmrw|tmr|tomorow|tonight|morning|afternoon|evening|night)\b/gi, ' ')
    .replace(/(بعد بكرا|بعد بكرة|بعد بكره|بعد غداً|بعد غد|اليوم|النهارده|اليومه|الليلة|الليله|بكرا|بكرة|بكره|باچر|باكر|غداً|غدا|الصبح|صباحاً|صباحا|صباح|بعد الظهر|بعد الضهر|العصر|المساء|المسا|مساءً|مساءا|مساء|بالليل|الليل)/gi, ' ')
    .replace(/(?:^|[\s,.،])(?:מחרתיים|מחר|היום|הערב|הלילה|בבוקר|בוקר|אחרי הצהריים|אחה"צ|בצהריים|צהריים|בערב|ערב|בלילה|לילה|חצות)(?=$|[\s,.،])/gi, ' ')
    .replace(/\b(?:on|this|next)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, ' ')
    .replace(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, ' ');
  // Arabic and Hebrew day names, as whole words and with «يوم» and «الجاي»
  // around them — the same tokenizer that resolves them, so «الأحداث» and
  // «הראשון» stay in the title exactly as they are not read as days.
  for (const source of WEEKDAY_MENTION_SOURCES) {
    stripped = stripped.replace(new RegExp(source, 'gu'), ' ');
  }
  // Ranges before the clocks inside them: taking "2pm" first would leave
  // "meeting from to" as the title.
  for (const source of [...RANGE_PATTERN_SOURCES, ...CLOCK_PATTERN_SOURCES]) {
    stripped = stripped.replace(new RegExp(source, 'gi'), ' ');
  }
  return stripped.replace(/\s+/g, ' ').trim();
}

function cleanAction(raw: string): string {
  // «سجّل», «حط لي», "note:" — an instruction to the app, not the task (L4).
  return stripCaptureCommand(stripTiming(raw))
    .replace(/^\s*(please\s+)?(remind me to|remind me|remember to|i need to|need to|i have to|have to|todo:?|task:?)\s+/i, '')
    .replace(/^\s*(urgent|asap|critical|important|must|maybe|optional)[:\s-]+/i, '')
    .replace(/\s+(urgent|asap|critical|important|must|maybe|optional)\s*$/i, '')
    .replace(/^\s*(ذكرني اني|ذكرني|ذكريني|بدي|لازم|محتاج|احتاج|علي|عليّ)\s+/i, '')
    .replace(/^\s*(ضروري|مستعجل|مهم|لازم|يمكن|عادي|مش ضروري)[:\s-]+/i, '')
    .replace(/\s+(ضروري|مستعجل|مهم|لازم|يمكن|عادي|مش ضروري)\s*$/i, '')
    .replace(/^\s*(?:בבקשה\s+)?(תזכיר לי ש|תזכירי לי ש|להזכיר לי ש|תזכיר לי|תזכירי לי|להזכיר לי|אני צריך|אני צריכה|צריך|צריכה|אני חייב|אני חייבת|חייב|חייבת|אני רוצה|רוצה)\s+/i, '')
    .replace(/^\s*(דחוף|חשוב|קריטי|חובה|אולי|לא דחוף|אפשר)[:\s-]+/i, '')
    .replace(/\s+(דחוף|חשוב|קריטי|חובה|אולי|לא דחוף|אפשר)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferPriority(raw: string, time: ParsedTime): ExtractionResult['priority'] {
  const lower = raw.toLowerCase();
  const pressureImplied = /\b(push me|bug me|don't let me|dont let me|do not let me)\b/.test(lower);
  if (/\b(maybe|probably|sometime|optional)\b/.test(lower) || /(مش ضروري|يمكن|عادي)/.test(lower) || /(?:^|[\s,.،])(אולי|לא דחוף)(?=$|[\s,.،])/.test(lower)) {
    return { level: 'low', source: 'inferred', pressureAllowed: false, pressureImplied: false };
  }
  if (/\b(urgent|asap|critical|important|must)\b/.test(lower) || /(ضروري|مستعجل|مهم|لازم)/.test(lower) || /(?:^|[\s,.،])(דחוף|חשוב|קריטי|חובה)(?=$|[\s,.،])/.test(lower) || pressureImplied) {
    return { level: 'high', source: pressureImplied ? 'inferred' : 'user_explicit', pressureAllowed: false, pressureImplied };
  }
  // A doctor, an exam, a flight on a fixed day is not a "should" (L4). It is
  // still our reading, not their words — `inferred`, so the review card marks
  // it as a guess they can change.
  if (isFixedAppointment(raw, { hasDay: Boolean(time.localTimeSpec?.date), hasClock: Boolean(time.localTimeSpec?.time) })) {
    return { level: 'high', source: 'inferred', pressureAllowed: false, pressureImplied: false };
  }
  return { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false };
}

function confidence(overall: number, action: number, time: number, priority = 0.8): ExtractionResult['confidence'] {
  return { overall, type: overall, action, time, priority };
}

/**
 * A result that produces no commitment, and says why.
 *
 * `informational_context` for everything the user was telling us, and `unknown`
 * for a negated request — which is not information, it is an instruction not to
 * act, and the disposition policy already refuses to auto-confirm it.
 *
 * The title is null on purpose. Echoing the sentence back as a title is how
 * «صباح الخير» became a commitment in the first place, and a no-commitment
 * outcome has nothing to name.
 */
function nothingResult(raw: string, kind: ReturnType<typeof classifyMessageKind>): ExtractionResult {
  const negated = kind === 'negated_request';
  return {
    type: negated ? 'unknown' : 'informational_context',
    action: null,
    title: null,
    person: null,
    dueAt: null,
    remindAt: null,
    localTimeSpec: null,
    timeEvidence: 'none',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'soft',
    ...NO_CATEGORY,
    // A negated request is capped below `MEDIUM_CONFIDENCE`, the same cap the
    // schema validator has always applied to one. Without it the disposition
    // policy reads `unknown` with high confidence as `needs_clarification`, and
    // the product would answer "don't remind me about the gym" with a question
    // about the gym.
    confidence: negated
      ? { overall: 0.55, type: 0.95, action: 0.1, time: 0.1, priority: 0.8 }
      : { overall: 0.95, type: 0.95, action: 0.1, time: 0.1, priority: 0.8 },
    missingFields: ['action'],
    ambiguityFlags: negated
      ? ['negated_request']
      : kind === 'informational' || kind === 'past_event'
        ? ['informational_without_action']
        : ['no_action_verb'],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
    rawText: raw,
    parserVersion: PARSER_VERSION,
  };
}

export function extract(rawText: string, context: ExtractionContext): ExtractionResult {
  const raw = rawText.trim();

  // Before asking what commitment is in this, ask whether it is asking for one
  // (UC-2.6, #166). Without this the extractor answered "what task is this" for
  // every input, so «صباح الخير» became a task titled "الخير" and «מה השעה?»
  // became one titled "מה השעה?" — 27 of the 40 synthetic safety cases created
  // something. The classifier is deterministic rather than a prompt instruction
  // because this extractor is *the* engine whenever AI consent has not been
  // granted, which is every new account.
  const kind = classifyMessageKind(raw);
  if (createsNothing(kind)) return nothingResult(raw, kind);

  const lower = raw.toLowerCase();
  const negatedReminderRequest =
    /\b(don't|dont|do not|not)\s+(remind|remember|bug)\b/.test(lower) ||
    /\b(remind me|remember to|bug me)\s+not\b/.test(lower) ||
    /(?:^|[\s,.،])אל\s+(?:תזכיר|תזכירי|תזכירו)(?=$|[\s,.،])/.test(lower);
  const explicitReminderRequest =
    !negatedReminderRequest &&
    (/\b(remind me|remember to|bug me)\b/.test(lower) ||
      /(ذكرني|ذكريني)/.test(lower) ||
      /(?:^|[\s,.،])(?:בבקשה\s+)?(?:תזכיר לי|תזכירי לי|להזכיר לי)(?=$|[\s,.،])/.test(lower));
  const explicitPressureRequest = /\b(push me|bug me|don't let me|dont let me|do not let me)\b/.test(lower);
  const missingFields: ExtractionResult['missingFields'] = [];
  const ambiguityFlags: ExtractionResult['ambiguityFlags'] = [];
  const parsedTime = parseDateTime(raw, context);
  const priority = inferPriority(raw, parsedTime);

  if (/\band\b.+\b(remind me|i need to|follow up|call|email|text)\b/.test(lower)) {
    ambiguityFlags.push('multiple_commitments');
  }
  if (negatedReminderRequest) {
    ambiguityFlags.push('negated_request');
  }

  const followUp = raw.match(/\bfollow up with\s+([A-Z][a-z]+|[a-z]+)(?:\s+about\s+(.+?))?(?:\s+(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at|by)\b.*)?$/i);
  if (followUp) {
    const person = followUp[1].trim();
    const topic = followUp[2] ? stripTiming(followUp[2]).trim() : '';
    const title = topic ? `Follow up with ${person} about ${topic}` : `Follow up with ${person}`;
    if (!parsedTime.remindAt) missingFields.push('time');
    return {
      type: 'follow_up',
      action: title,
      title,
      person,
      dueAt: parsedTime.dueAt,
      remindAt: parsedTime.remindAt,
      localTimeSpec: parsedTime.localTimeSpec,
      timeEvidence: parsedTime.evidence,
      dateInferred: parsedTime.dateInferred,
      priority,
      flexibility: 'movable',
      ...NO_CATEGORY,
      confidence: confidence(parsedTime.remindAt ? 0.86 : 0.68, 0.9, parsedTime.confidence),
      missingFields,
      ambiguityFlags,
      explicitReminderRequest,
      explicitPressureRequest,
      rawText: raw,
      parserVersion: PARSER_VERSION,
    };
  }

  if (INFORMATIONAL_RE.test(lower) && !explicitReminderRequest) {
    return {
      type: 'informational_context',
      action: null,
      title: raw,
      person: null,
      dueAt: null,
      remindAt: null,
      localTimeSpec: null,
      timeEvidence: 'none',
      priority,
      flexibility: 'soft',
      ...NO_CATEGORY,
      confidence: confidence(0.55, 0.1, 0.1),
      missingFields: ['action', 'time'],
      ambiguityFlags: ['informational_without_action'],
      explicitReminderRequest,
      explicitPressureRequest,
      rawText: raw,
      parserVersion: PARSER_VERSION,
    };
  }

  const action = cleanAction(raw);
  const weak =
    /\b(maybe|probably|sometime|should probably)\b/.test(lower) ||
    /(يمكن|عادي|مش ضروري)/.test(lower) ||
    /(?:^|[\s,.،])(אולי|לא דחוף)(?=$|[\s,.،])/.test(lower);
  if (!action || action.length < 3) {
    missingFields.push('action');
    ambiguityFlags.push('vague_action');
  }
  if (!parsedTime.remindAt) {
    missingFields.push('time');
    ambiguityFlags.push('vague_time');
  }
  if (weak) ambiguityFlags.push('weak_commitment_language');

  const actionConfidence = action && action.length >= 3 ? 0.82 : 0.2;
  const hasTime = Boolean(parsedTime.remindAt);
  let overall = 0.72;
  if (explicitReminderRequest && hasTime && actionConfidence >= 0.8 && !weak) overall = 0.9;
  if (!hasTime) overall = weak ? 0.5 : 0.62;
  if (weak && !explicitReminderRequest) overall = Math.min(overall, 0.58);
  if (negatedReminderRequest) overall = Math.min(overall, 0.55);
  if (ambiguityFlags.includes('multiple_commitments')) overall = Math.min(overall, 0.55);

  return {
    type: 'task',
    action: action || null,
    title: action || raw,
    person: null,
    dueAt: parsedTime.dueAt,
    remindAt: parsedTime.remindAt,
    localTimeSpec: parsedTime.localTimeSpec,
    timeEvidence: parsedTime.evidence,
    dateInferred: parsedTime.dateInferred,
    priority,
    flexibility: weak ? 'soft' : 'movable',
    ...NO_CATEGORY,
    confidence: confidence(overall, actionConfidence, parsedTime.confidence),
    missingFields,
    ambiguityFlags,
    explicitReminderRequest,
    explicitPressureRequest,
    rawText: raw,
    parserVersion: PARSER_VERSION,
  };
}

/**
 * How many distinct clock times the raw text names.
 *
 * The extractor reads a time with `String.match` against a non-global regex,
 * which returns the first match and silently discards the rest. A sentence
 * carrying three times can therefore produce one commitment that looks
 * complete, and the confidence policy — which only ever sees that one
 * result — reports no clarification needed.
 *
 * It reads `RANGE_PATTERN_SOURCES` and `CLOCK_PATTERN_SOURCES`, the same lists
 * `stripTiming` removes from a title, so the counter and the parser cannot
 * disagree about what a time looks like.
 */
export function countTimeExpressions(raw: string): number {
  if (typeof raw !== 'string' || !raw.trim()) return 0;
  // Count what the parser reads: «الساعة تسعة» and «בשעה תשע» both become 9.
  const text = normalizeSpokenHebrewHours(normalizeSpokenArabicHours(normalizeArabicDigits(raw)));

  // Count positions, not matches: two patterns can describe the same mention
  // ("at 9am" matches both the am-suffixed and the bare-hour shape), and
  // counting each would invent a time the sentence never had.
  const covered = new Set<number>();

  // Pass 1: a range counts once, at its first digit, and claims its span.
  const spans: Array<readonly [number, number]> = [];
  forEachTimeMention(RANGE_PATTERN_SOURCES, text, (start, end, digitAt) => {
    spans.push([start, end]);
    covered.add(digitAt);
  });

  // Pass 2: clock times, except the start and end already inside a range.
  forEachTimeMention(CLOCK_PATTERN_SOURCES, text, (_start, _end, digitAt) => {
    if (!spans.some(([start, end]) => digitAt >= start && digitAt < end)) covered.add(digitAt);
  });
  return covered.size;
}

function forEachTimeMention(
  sources: readonly string[],
  text: string,
  visit: (start: number, end: number, digitAt: number) => void,
): void {
  for (const source of sources) {
    const pattern = new RegExp(source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // A zero-width match would spin forever; step past it.
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      // Anchor on where the digits sit, so overlapping shapes of one mention
      // collapse onto a single position.
      const digitOffset = match[0].search(/[0-9٠-٩۰-۹]/);
      if (digitOffset < 0) continue;
      visit(match.index, match.index + match[0].length, match.index + digitOffset);
    }
  }
}
