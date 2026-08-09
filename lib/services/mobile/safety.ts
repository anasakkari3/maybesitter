import type { ExtractAndMapOptions, ExtractWithFallbackResult } from '../../../src/extraction/extractionService';
import { extractWithFallback } from '../../../src/extraction/extractionService';
import type { ExtractionContext } from '../../../src/extraction/extractionTypes';
import { parseIsoDate } from './time';

const NEGATED_REQUEST =
  /\b(?:don't|dont|do not|never|no need to)\s+(?:remind|remember|schedule|add|create|notify)\b/i;

type MobileExtractor = (
  rawText: string,
  context: ExtractionContext,
  options?: ExtractAndMapOptions
) => Promise<ExtractWithFallbackResult>;

function assertSafeTime(value: string | null, now: Date, field: string): void {
  if (!value) return;
  const parsed = parseIsoDate(value, field);
  if (parsed.getTime() < now.getTime()) {
    throw new Error(`${field} must not be in the past`);
  }
}

export async function guardedMobileExtract(
  rawText: string,
  context: ExtractionContext,
  options: ExtractAndMapOptions = {},
  extractor: MobileExtractor = extractWithFallback
): Promise<ExtractWithFallbackResult> {
  if (NEGATED_REQUEST.test(rawText)) {
    throw new Error('negated reminder requests cannot become proposals');
  }

  const extracted = await extractor(rawText, context, options);
  if (extracted.result.ambiguityFlags.includes('negated_request')) {
    throw new Error('negated reminder requests cannot become proposals');
  }

  assertSafeTime(extracted.result.dueAt, context.now, 'dueAt');
  assertSafeTime(extracted.result.remindAt, context.now, 'remindAt');

  return extracted;
}
