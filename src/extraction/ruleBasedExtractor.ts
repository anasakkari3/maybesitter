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
  const clock = parseClock(raw);
  let targetDate: Date | null = null;
  let timeConfidence = 0;

  if (/\btoday\b/.test(lower) || /\btonight\b/.test(lower) || /(اليوم|النهارده|اليومه)/.test(lower)) {
    targetDate = new Date(now);
    timeConfidence = 0.85;
  }
  if (/\btomorrow\b/.test(lower) || /(بكرا|بكرة|غدا|غداً)/.test(lower)) {
    targetDate = addDays(now, 1);
    timeConfidence = 0.9;
  }
  if (/\b(after tomorrow|day after tomorrow)\b/.test(lower) || /(بعد بكرا|بعد بكرة|بعد غد|بعد غداً)/.test(lower)) {
    targetDate = addDays(now, 2);
    timeConfidence = 0.9;
  }

  const weekday = lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekday) {
    targetDate = nextWeekday(now, WEEKDAYS[weekday[1]]);
    timeConfidence = 0.88;
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

  const withTime = setTime(targetDate, hour, minute);
  return { dueAt: withTime.toISOString(), remindAt: withTime.toISOString(), confidence: timeConfidence };
}

function stripTiming(text: string): string {
  return text
    .replace(/\b(after tomorrow|day after tomorrow|today|tomorrow|tonight|morning|afternoon|evening|night)\b/gi, ' ')
    .replace(/(بعد بكرا|بعد بكرة|بعد غداً|بعد غد|اليوم|النهارده|اليومه|بكرا|بكرة|غداً|غدا|الصبح|صباح|بعد الظهر|بعد الضهر|المساء|المسا|مساء|بالليل|الليل)/gi, ' ')
    .replace(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, ' ')
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

  if (/\b(waiting on|for your information|fyi|just so you know)\b/.test(lower) && !explicitReminderRequest) {
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
