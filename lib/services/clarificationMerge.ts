import type { ExtractionContext, ExtractionResult, MissingField } from '../../src/extraction/extractionTypes';
import type { PendingClarification } from './clarificationStore';

export type ClarificationMergeResult =
  | { status: 'merged'; inputText: string }
  | { status: 'ambiguous'; result: ExtractionResult; reason: string };

const DATE_PATTERN = /\b(today|tomorrow|tonight|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
const WEEKDAY_OR_RELATIVE_PATTERN = /\b(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;
const TIME_PATTERN = /\b(?:at|by|around)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(morning|afternoon|evening|tonight|night)\b/i;
const BARE_TIME_PATTERN = /\b(?:at|by|around)\s+(\d{1,2})(?::(\d{2}))?\b/i;
const TIMING_PATTERN = /\b(today|tomorrow|tonight|morning|afternoon|evening|night|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b(?:at|by|around)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:at|by|around)\s+\d{1,2}(?::\d{2})?\b/gi;
const CORRECTION_PATTERN = /^\s*(actually|no|nope|instead|change it to|make it|make that|rather|scratch that)\b[,\s:]*/i;
const ACTION_PATTERN = /\b(call|text|email|message|follow up with|follow up|send|pay|book|schedule|submit|finish|review|check|pick up|buy)\b/i;
const MULTIPLE_OPTION_PATTERN = /\b(?:or|either)\b/i;
const NAME_PATTERN = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?$/;

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripLeadingReminder(text: string): string {
  return compact(text.replace(/^\s*(please\s+)?(remind me to|remind me|remember to|i need to|need to|i have to|have to|todo:?|task:?)\s+/i, ''));
}

function stripTiming(text: string): string {
  return compact(text.replace(TIMING_PATTERN, ' '));
}

function hasDate(text: string): boolean {
  return DATE_PATTERN.test(text);
}

function hasTime(text: string): boolean {
  return TIME_PATTERN.test(text) || BARE_TIME_PATTERN.test(text);
}

function timingPieces(text: string): string[] {
  const matches = text.match(TIMING_PATTERN) || [];
  return matches.map((match) => compact(match)).filter(Boolean);
}

function datePieces(text: string): string[] {
  return timingPieces(text).filter((piece) => hasDate(piece));
}

function timePieces(text: string): string[] {
  return timingPieces(text).filter((piece) => hasTime(piece) && !hasDate(piece));
}

function hasMultipleDateOptions(text: string): boolean {
  const dates = text.match(WEEKDAY_OR_RELATIVE_PATTERN) || [];
  return dates.length > 1 || (DATE_PATTERN.test(text) && MULTIPLE_OPTION_PATTERN.test(text));
}

function normalizeBareTime(text: string): string | null {
  const match = text.match(BARE_TIME_PATTERN);
  if (!match) return text;

  if (/\b(?:am|pm)\b/i.test(text)) return text;

  const hour = Number(match[1]);
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return null;

  // A bare "at 5" in a clarification is usually an end-of-day reminder.
  // Keep the inference narrow so unclear morning/workday times do not silently mutate.
  if (hour >= 1 && hour <= 7) {
    return text.replace(BARE_TIME_PATTERN, (value) => `${value}pm`);
  }

  return null;
}

function continuationWithoutCorrection(reply: string): string {
  return compact(reply.replace(CORRECTION_PATTERN, ''));
}

function isCorrection(reply: string): boolean {
  return CORRECTION_PATTERN.test(reply);
}

function looksLikePerson(text: string): boolean {
  if (hasDate(text) || hasTime(text)) return false;
  return NAME_PATTERN.test(text) || /\b(with|to|for)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/.test(text);
}

function hasAction(text: string): boolean {
  return ACTION_PATTERN.test(text);
}

function baseAction(pending: PendingClarification): string {
  const partial = pending.partialExtraction;
  return stripTiming(partial.action || partial.title || stripLeadingReminder(pending.originalInput));
}

function timingFromOriginal(pending: PendingClarification): string {
  return timingPieces(pending.originalInput).join(' ');
}

function mergedTiming(pending: PendingClarification, reply: string): string {
  const replyHasDate = hasDate(reply);
  const replyHasTime = hasTime(reply);
  const originalDate = datePieces(pending.originalInput).join(' ');
  const originalTime = timePieces(pending.originalInput).join(' ');

  if (replyHasDate && !replyHasTime && originalTime) return compact(`${reply} ${originalTime}`);
  if (replyHasTime && !replyHasDate && originalDate) return compact(`${originalDate} ${reply}`);
  return reply;
}

function baseReminderText(pending: PendingClarification): string {
  const action = baseAction(pending);
  return action ? `Remind me to ${action}` : stripTiming(pending.originalInput);
}

function missingFieldResult(
  pending: PendingClarification,
  missingFields: MissingField[],
  reason: string
): ClarificationMergeResult {
  const uniqueMissingFields = missingFields.filter((field, index) => missingFields.indexOf(field) === index);
  return {
    status: 'ambiguous',
    reason,
    result: {
      ...pending.partialExtraction,
      missingFields: uniqueMissingFields.length > 0 ? uniqueMissingFields : pending.partialExtraction.missingFields,
      ambiguityFlags: ['vague_time'],
      confidence: {
        ...pending.partialExtraction.confidence,
        overall: Math.min(pending.partialExtraction.confidence.overall, 0.45),
      },
    },
  };
}

function correctionResult(pending: PendingClarification, reply: string, context: ExtractionContext): ClarificationMergeResult {
  const correction = continuationWithoutCorrection(reply);
  if (!correction) {
    return missingFieldResult(pending, pending.partialExtraction.missingFields, 'The correction did not include a usable detail.');
  }

  if (hasMultipleDateOptions(correction)) {
    return {
      status: 'ambiguous',
      reason: 'The correction included more than one possible date.',
      result: {
        ...pending.partialExtraction,
        missingFields: ['time'],
        ambiguityFlags: ['contradictory_time'],
        confidence: {
          ...pending.partialExtraction.confidence,
          overall: Math.min(pending.partialExtraction.confidence.overall, 0.45),
          time: Math.min(pending.partialExtraction.confidence.time, 0.35),
        },
      },
    };
  }

  const normalizedCorrection = normalizeBareTime(correction);
  if (!normalizedCorrection && hasTime(correction)) {
    return missingFieldResult(pending, ['time'], 'The correction used an ambiguous time.');
  }

  const cleanCorrection = normalizedCorrection || correction;
  const hasCorrectionDate = hasDate(cleanCorrection);
  const hasCorrectionTime = hasTime(cleanCorrection);
  const originalTiming = timingFromOriginal(pending);

  if ((hasCorrectionDate || hasCorrectionTime) && !hasAction(cleanCorrection) && !looksLikePerson(cleanCorrection)) {
    const originalAction = baseReminderText(pending);
    const timing = mergedTiming(pending, cleanCorrection) || originalTiming;
    return { status: 'merged', inputText: compact(`${originalAction} ${timing || cleanCorrection}`) };
  }

  if (hasAction(cleanCorrection)) {
    const originalTimingText = originalTiming || (pending.partialExtraction.remindAt ? `at ${new Date(pending.partialExtraction.remindAt).toISOString()}` : '');
    return {
      status: 'merged',
      inputText: compact(`Remind me to ${stripLeadingReminder(cleanCorrection)} ${originalTimingText}`),
    };
  }

  if (looksLikePerson(cleanCorrection) && pending.partialExtraction.missingFields.includes('person')) {
    return { status: 'merged', inputText: compact(`${baseReminderText(pending)} with ${cleanCorrection}`) };
  }

  const missing: MissingField[] = pending.partialExtraction.missingFields.length > 0 ? pending.partialExtraction.missingFields : ['action'];
  return missingFieldResult(pending, missing, 'The correction was not specific enough to apply safely.');
}

function fillMissingSlot(pending: PendingClarification, reply: string): ClarificationMergeResult {
  if (hasMultipleDateOptions(reply)) {
    return {
      status: 'ambiguous',
      reason: 'The reply included more than one possible date.',
      result: {
        ...pending.partialExtraction,
        missingFields: ['time'],
        ambiguityFlags: ['contradictory_time'],
      },
    };
  }

  const normalizedReply = normalizeBareTime(reply);
  if (!normalizedReply && hasTime(reply)) {
    return missingFieldResult(pending, ['time'], 'The reply used an ambiguous time.');
  }

  const cleanReply = normalizedReply || reply;
  const missing = pending.partialExtraction.missingFields;
  const originalTiming = timingFromOriginal(pending);

  if (missing.includes('time') && (hasDate(cleanReply) || hasTime(cleanReply))) {
    return { status: 'merged', inputText: compact(`${baseReminderText(pending)} ${mergedTiming(pending, cleanReply)}`) };
  }

  if (missing.includes('person') && (looksLikePerson(cleanReply) || hasAction(cleanReply))) {
    const personReply = hasAction(cleanReply) ? stripLeadingReminder(cleanReply) : `with ${cleanReply}`;
    return { status: 'merged', inputText: compact(`${baseReminderText(pending)} ${personReply} ${originalTiming}`) };
  }

  if (missing.includes('action') && hasAction(cleanReply)) {
    return { status: 'merged', inputText: compact(`Remind me to ${stripLeadingReminder(cleanReply)} ${originalTiming}`) };
  }

  if (hasDate(cleanReply) || hasTime(cleanReply) || hasAction(cleanReply) || looksLikePerson(cleanReply)) {
    return { status: 'merged', inputText: compact(`${baseReminderText(pending)} ${cleanReply}`) };
  }

  return missingFieldResult(pending, missing, 'The reply did not include a clear enough detail.');
}

export function mergeClarificationInput(
  pending: PendingClarification,
  reply: string,
  context: ExtractionContext
): ClarificationMergeResult {
  const cleanReply = compact(reply);
  if (!cleanReply) {
    return missingFieldResult(pending, pending.partialExtraction.missingFields, 'The continuation was empty.');
  }

  if (isCorrection(cleanReply)) {
    return correctionResult(pending, cleanReply, context);
  }

  return fillMissingSlot(pending, cleanReply);
}
