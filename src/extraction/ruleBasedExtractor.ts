import type { ExtractionContext, ExtractionResult } from './extractionTypes';

const PARSER_VERSION = 'rule-v1-core';
const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const AR_WEEKDAYS: Record<string, number> = {
  'الأحد': 0,
  'الاحد': 0,
  'الاثنين': 1,
  'الإثنين': 1,
  'الأثنين': 1,
  'الثلاثاء': 2,
  'الثلثاء': 2,
  'الأربعاء': 3,
  'الاربعاء': 3,
  'الخميس': 4,
  'الجمعة': 5,
  'السبت': 6,
};

const AR_WEEKDAY_RE = /(الأحد|الاحد|الاثنين|الإثنين|الأثنين|الثلاثاء|الثلثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت)/;

const INFORMATIONAL_RE =
  /\b(waiting on|for your information|fyi|just so you know|asked me about|told me about)\b|(سألتني|سألني|تسألني|مستني|مستنية|بانتظار|ينتظر|تنتظر|قالت لي|قال لي)|(מחכה|מחכים|שאל אותי|שאלה אותי|ביקש ממני)|(i|we) had a (nice|great|good|bad|tiring|long|busy|rough) (day|week|morning|afternoon|evening|night)\b/i;

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function setTime(date: Date, hour: number, minute = 0): Date {
  const next = new Date(date);
  next.setHours(hour, minute, 0, 0);
  return next;
}

function nextWeekday(from: Date, weekday: number): Date {
  return addDays(from, (weekday - from.getDay() + 7) % 7);
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

function nextWeekdayTz(from: Date, weekday: number, timeZone: string): Date {
  const parts = wallClockParts(from, timeZone);
  const currentWeekday = new Date(Date.UTC(parts.year, parts.month, parts.day)).getUTCDay();
  const diff = (weekday - currentWeekday + 7) % 7;
  return addDaysTz(from, diff, timeZone);
}

function resolveTimezone(context: ExtractionContext): string {
  return context.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function normalizeArabicDigits(value: string): string {
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabicIndex = arabic.indexOf(digit);
    if (arabicIndex !== -1) return String(arabicIndex);
    return String(persian.indexOf(digit));
  });
}

function parseClock(raw: string): { hour: number; minute: number } | null {
  const normalized = normalizeArabicDigits(raw).toLowerCase();
  const explicit =
    normalized.match(/(?:\b(?:at|by|around)\b|الساعة|الساعه|عند|على)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|صباحا|صباحاً|الصبح|ص|مساء|مساءً|المسا|المساء|بالليل|م)?(?=$|[\s,.،])/) ||
    normalized.match(/\b(\d{1,2}):(\d{2})(?=$|[\s,.،])/) ||
    normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|صباحا|صباحاً|الصبح|ص|مساء|مساءً|المسا|المساء|بالليل|م)(?=$|[\s,.،])/);
  if (!explicit) return null;
  let hour = Number(explicit[1]);
  const minute = explicit[2] ? Number(explicit[2]) : 0;
  const period = explicit[3] || '';
  if (hour < 1 || hour > 23 || minute < 0 || minute > 59) return null;
  if (/(pm|مساء|المسا|المساء|بالليل|م)/.test(period) && hour < 12) hour += 12;
  if (/(am|صباح|الصبح|ص)/.test(period) && hour === 12) hour = 0;
  return { hour, minute };
}

function parseDateTime(raw: string, context: ExtractionContext): { dueAt: string | null; remindAt: string | null; confidence: number } {
  const lower = raw.toLowerCase();
  const now = context.now;
  const tz = resolveTimezone(context);
  const clock = parseClock(raw);
  let targetDate: Date | null = null;
  let timeConfidence = 0;

  if (/\btoday\b/.test(lower) || /\btonight\b/.test(lower) || /(اليوم|النهارده|اليومه)/.test(lower)) {
    targetDate = new Date(now);
    timeConfidence = 0.85;
  }
  if (/\btomorrow\b/.test(lower) || /(بكرا|بكرة|غدا|غداً)/.test(lower)) {
    targetDate = addDaysTz(now, 1, tz);
    timeConfidence = 0.9;
  }
  if (/\b(after tomorrow|day after tomorrow)\b/.test(lower) || /(بعد بكرا|بعد بكرة|بعد غد|بعد غداً)/.test(lower)) {
    targetDate = addDaysTz(now, 2, tz);
    timeConfidence = 0.9;
  }

  const weekday = lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/) || lower.match(AR_WEEKDAY_RE);
  if (weekday) {
    const day = WEEKDAYS[weekday[1]] ?? AR_WEEKDAYS[weekday[1]];
    if (day !== undefined) {
      targetDate = nextWeekdayTz(now, day, tz);
      timeConfidence = 0.88;
    }
  }

  if (!targetDate && clock) {
    targetDate = new Date(now);
    timeConfidence = 0.72;
  }

  if (!targetDate) {
    return { dueAt: null, remindAt: null, confidence: 0.1 };
  }

  let hour = context.defaultReminderHour ?? 18;
  let minute = 0;
  if (/\bmorning\b|الصبح|صباح/.test(lower)) hour = 9;
  if (/\bafternoon\b|بعد الظهر|بعد الضهر/.test(lower)) hour = 14;
  if (/\bevening\b|المسا|المساء|مساء/.test(lower)) hour = 18;
  if (/\btonight\b|\bnight\b|بالليل|الليل/.test(lower)) hour = 20;
  if (clock) {
    hour = clock.hour;
    minute = clock.minute;
    timeConfidence = Math.max(timeConfidence, 0.95);
  }

  const withTime = setTimeTz(targetDate, hour, minute, tz);
  return { dueAt: withTime.toISOString(), remindAt: withTime.toISOString(), confidence: timeConfidence };
}

function stripTiming(text: string): string {
  return text
    .replace(/\b(after tomorrow|day after tomorrow|today|tomorrow|tonight|morning|afternoon|evening|night)\b/gi, ' ')
    .replace(/(بعد بكرا|بعد بكرة|بعد غداً|بعد غد|اليوم|النهارده|اليومه|بكرا|بكرة|غداً|غدا|الصبح|صباحاً|صباحا|صباح|بعد الظهر|بعد الضهر|المساء|المسا|مساءً|مساءا|مساء|بالليل|الليل)/gi, ' ')
    .replace(/\b(?:on|this|next)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, ' ')
    .replace(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, ' ')
    .replace(/(الأحد|الاحد|الاثنين|الإثنين|الأثنين|الثلاثاء|الثلثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت)/gi, ' ')
    .replace(/\b(?:at|by|around)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, ' ')
    .replace(/\b(?:at|by|around)\s*\d{1,2}(?::\d{2})?(?=$|[\s,.،])/gi, ' ')
    .replace(/\bfrom\s+\d{1,2}:\d{2}\s+to\s+\d{1,2}:\d{2}\b/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}(?=$|[\s,.،])/gi, ' ')
    .replace(/(?:الساعة|الساعه|عند|على)?\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?\s*(?:صباحا|صباحاً|الصبح|ص|مساء|مساءً|المسا|المساء|بالليل|م)(?=$|[\s,.،])/gi, ' ')
    .replace(/(?:الساعة|الساعه|عند|على)\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?(?=$|[\s,.،])/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanAction(raw: string): string {
  return stripTiming(raw)
    .replace(/^\s*(please\s+)?(remind me to|remind me|remember to|i need to|need to|i have to|have to|todo:?|task:?)\s+/i, '')
    .replace(/^\s*(urgent|asap|critical|important|must|maybe|optional)[:\s-]+/i, '')
    .replace(/\s+(urgent|asap|critical|important|must|maybe|optional)\s*$/i, '')
    .replace(/^\s*(ذكرني اني|ذكرني|ذكريني|بدي|لازم|محتاج|احتاج|علي|عليّ)\s+/i, '')
    .replace(/^\s*(ضروري|مستعجل|مهم|لازم|يمكن|عادي|مش ضروري)[:\s-]+/i, '')
    .replace(/\s+(ضروري|مستعجل|مهم|لازم|يمكن|عادي|مش ضروري)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferPriority(raw: string): ExtractionResult['priority'] {
  const lower = raw.toLowerCase();
  const pressureImplied = /\b(push me|bug me|don't let me|dont let me|do not let me)\b/.test(lower);
  if (/\b(maybe|probably|sometime|optional)\b/.test(lower) || /(مش ضروري|يمكن|عادي)/.test(lower)) {
    return { level: 'low', source: 'inferred', pressureAllowed: false, pressureImplied: false };
  }
  if (/\b(urgent|asap|critical|important|must)\b/.test(lower) || /(ضروري|مستعجل|مهم|لازم)/.test(lower) || pressureImplied) {
    return { level: 'high', source: pressureImplied ? 'inferred' : 'user_explicit', pressureAllowed: false, pressureImplied };
  }
  return { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false };
}

function confidence(overall: number, action: number, time: number, priority = 0.8): ExtractionResult['confidence'] {
  return { overall, type: overall, action, time, priority };
}

export function extract(rawText: string, context: ExtractionContext): ExtractionResult {
  const raw = rawText.trim();
  const lower = raw.toLowerCase();
  const negatedReminderRequest = /\b(don't|dont|do not|not)\s+(remind|remember|bug)\b/.test(lower) || /\b(remind me|remember to|bug me)\s+not\b/.test(lower);
  const explicitReminderRequest = !negatedReminderRequest && (/\b(remind me|remember to|bug me)\b/.test(lower) || /(ذكرني|ذكريني)/.test(lower));
  const explicitPressureRequest = /\b(push me|bug me|don't let me|dont let me|do not let me)\b/.test(lower);
  const missingFields: ExtractionResult['missingFields'] = [];
  const ambiguityFlags: ExtractionResult['ambiguityFlags'] = [];
  const parsedTime = parseDateTime(raw, context);
  const priority = inferPriority(raw);

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
      priority,
      flexibility: 'movable',
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
      priority,
      flexibility: 'soft',
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
  const weak = /\b(maybe|probably|sometime|should probably)\b/.test(lower) || /(يمكن|عادي|مش ضروري)/.test(lower);
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
    priority,
    flexibility: weak ? 'soft' : 'movable',
    confidence: confidence(overall, actionConfidence, parsedTime.confidence),
    missingFields,
    ambiguityFlags,
    explicitReminderRequest,
    explicitPressureRequest,
    rawText: raw,
    parserVersion: PARSER_VERSION,
  };
}
