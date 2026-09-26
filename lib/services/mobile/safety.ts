import type { ExtractAndMapOptions, ExtractWithFallbackResult } from '../../../src/extraction/extractionService';
import { extractWithFallback } from '../../../src/extraction/extractionService';
import type { ExtractionContext } from '../../../src/extraction/extractionTypes';
import { isPastCommitmentTime, pastTimeMessage } from '../commitments/timeRules';
import { parseIsoInstant } from './time';

/**
 * A negated request, refused by type rather than by message (UC-2.6, #166).
 *
 * It used to be a bare `Error`, which the capture boundary caught and reported
 * as `rejected` — and the route turned that into HTTP 400. So "don't remind me
 * about the gym anymore" was answered with an error, for a request the product
 * understood perfectly and was right to refuse. A typed error lets the boundary
 * tell this apart from an injection or a past time, which are genuinely unsafe
 * rather than simply empty.
 */
export class NegatedRequestError extends Error {
  constructor() {
    super('a negated reminder request cannot become a proposal');
    this.name = 'NegatedRequestError';
  }
}

/**
 * The extractor read a time that has already gone (CL1, round 1).
 *
 * Typed for the same reason as `NegatedRequestError`: the capture boundary has
 * to tell it apart from an unsafe input. In a capture of several clauses, one
 * clause whose hour has passed — «…وذكرني أتصل بأمي اليوم الساعة 9 الصبح» at
 * 10:00 — used to reject the whole capture, the bread with it. The message is
 * unchanged and carries nothing the user wrote.
 */
export class PastCommitmentTimeError extends Error {
  /**
   * What the guarded extractor read, so the boundary can offer that same
   * reading without its hour (CL1 round 3, M5) rather than re-reading the
   * clause with an unguarded extractor — which skipped the negation check,
   * relabelled provenance, and could pick a *future* reading of an ambiguous
   * hour and propose it unasked.
   *
   * Not enumerable: it holds the user's text, and an error is the kind of
   * object that ends up in a log. `util.inspect` and `JSON.stringify` both
   * skip it.
   */
  declare readonly extracted: ExtractWithFallbackResult | undefined;

  constructor(message: string, extracted?: ExtractWithFallbackResult) {
    super(message);
    this.name = 'PastCommitmentTimeError';
    Object.defineProperty(this, 'extracted', { value: extracted, enumerable: false });
  }
}

const NEGATED_REQUEST = new RegExp([
  /\b(?:don't|dont|do not|never|no need to|stop)\s+(?:remind|remember|schedule|add|create|notify|bug)\b/.source,
  /\b(?:remind me|remember to|bug me)\s+not\b/.source,
  /(?:תזכיר לי|תזכירי לי|ذكرني|ذكريني|remind me)\s+not\b/.source,
  /لا تذكرني|لا تذكريني|ما تذكرني|ما تذكريني|بلا تذكير|مش بدي تذكير|ما بدي تذكير|ما بديش تذكير|بطل تذكرني|بطلي تذكريني/.source,
  /אל תזכיר לי|אל תזכירי לי|לא צריך להזכיר|תפסיק להזכיר|תפסיקי להזכיר/.source,
].join('|'), 'i');

type MobileExtractor = (
  rawText: string,
  context: ExtractionContext,
  options?: ExtractAndMapOptions
) => Promise<ExtractWithFallbackResult>;

/**
 * The extractor's answer, checked against the clock it was asked about.
 *
 * This wrote its own comparison and its own copy of the wording. `timeRules`
 * owns both now (#352) — the wording especially, since this file is where
 * `must not be in the past` was first phrased and the PATCH boundary had to
 * match it by hand to stay consistent.
 */
function assertSafeTime(value: string | null, now: Date, field: string, extracted?: ExtractWithFallbackResult): void {
  if (!value) return;
  const parsed = parseIsoInstant(value, field);
  if (isPastCommitmentTime(parsed, now)) throw new PastCommitmentTimeError(pastTimeMessage(field), extracted);
}

export async function guardedMobileExtract(
  rawText: string,
  context: ExtractionContext,
  options: ExtractAndMapOptions = {},
  extractor: MobileExtractor = extractWithFallback
): Promise<ExtractWithFallbackResult> {
  if (NEGATED_REQUEST.test(rawText)) {
    throw new NegatedRequestError();
  }

  const extracted = await extractor(rawText, context, options);
  if (extracted.result.ambiguityFlags.includes('negated_request')) {
    throw new NegatedRequestError();
  }

  assertSafeTime(extracted.result.dueAt, context.now, 'dueAt', extracted);
  assertSafeTime(extracted.result.remindAt, context.now, 'remindAt', extracted);

  return extracted;
}
