import type { ExtractWithFallbackResult } from '../../../src/extraction/extractionService';
import { extractWithFallback } from '../../../src/extraction/extractionService';
import type { ExtractionContext } from '../../../src/extraction/extractionTypes';
import { parseIsoDate } from './time';

const NEGATED_REQUEST =
  /\b(?:don't|dont|do not|never|no need to)\s+(?:remind|remember|schedule|add|create|notify)\b/i;
const PAST_TIME_REQUEST =
  /\b(?:yesterday|last night|last week|earlier)\b|(?:مبارح|أمس|امبارح|אתמול|בשבוע שעבר)/i;

function assertSafeTime(value: string | null, now: Date, field: string): void {
  if (!value) return;
  const parsed = parseIsoDate(value, field);
  if (parsed.getTime() < now.getTime()) {
    throw new Error(`${field} must not be in the past`);
  }
}

export async function guardedMobileExtract(
  rawText: string,
  context: ExtractionContext
): Promise<ExtractWithFallbackResult> {
  if (NEGATED_REQUEST.test(rawText)) {
    throw new Error('negated reminder requests cannot become proposals');
  }
  if (PAST_TIME_REQUEST.test(rawText)) {
    throw new Error('past-time requests cannot become proposals');
  }

  const extracted = await extractWithFallback(rawText, context);
  if (extracted.result.ambiguityFlags.includes('negated_request')) {
    throw new Error('negated reminder requests cannot become proposals');
  }

  assertSafeTime(extracted.result.dueAt, context.now, 'dueAt');
  assertSafeTime(extracted.result.remindAt, context.now, 'remindAt');

  const hasResolvedTime = Boolean(extracted.result.remindAt || extracted.result.dueAt);
  const hasTitle = Boolean((extracted.result.title || extracted.result.action || '').trim());
  const canActivateAfterConfirm =
    (extracted.result.type === 'task' || extracted.result.type === 'follow_up') &&
    hasResolvedTime &&
    hasTitle &&
    !extracted.result.ambiguityFlags.includes('weak_commitment_language') &&
    !extracted.result.ambiguityFlags.includes('contradictory_time');

  return canActivateAfterConfirm
    ? {
        ...extracted,
        result: {
          ...extracted.result,
          explicitReminderRequest: true,
          confidence: {
            ...extracted.result.confidence,
            overall: Math.max(extracted.result.confidence.overall, 0.9),
          },
        },
      }
    : extracted;
}
