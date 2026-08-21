import type { ExtractionResult } from './extractionTypes';
import { screenForInjection } from './injectionBoundary';

/**
 * Which of the three things actually happened, as opposed to what the caller
 * should do about it.
 *
 * `agrees` answers "may the local proposal stand?" and is true in every case
 * except a real correction. That makes it useless for telling a corroborated
 * answer apart from one the remote model never gave -- a timeout, a throw, a
 * malformed reply, or a call the injection screen refused to make. Reporting
 * any of those as "the two models agreed" would overstate how much checking a
 * capture received, so the state is recorded separately.
 */
export type ArbitrationOutcome = 'agreed' | 'disagreed' | 'unavailable';

export interface ArbitrationVerdict {
  agrees: boolean;
  outcome: ArbitrationOutcome;
  correctedSplit: number | null;
  correctedTimes: string[];
  note: string | null;
}

export type ArbiterFunction = (
  rawText: string,
  proposal: ExtractionResult,
) => Promise<ArbitrationVerdict>;

/**
 * No second opinion was obtained. Behaviourally identical to agreement -- the
 * local proposal stands untouched -- but never counted as one.
 */
const UNAVAILABLE: ArbitrationVerdict = {
  agrees: true,
  outcome: 'unavailable',
  correctedSplit: null,
  correctedTimes: [],
  note: null,
};

export function buildArbiterPrompt(
  rawText: string,
  proposal: ExtractionResult,
): string {
  return [
    'A local model read the text below and produced the proposal that follows.',
    'Judge the proposal. Do not extract from scratch.',
    '',
    'TEXT:',
    rawText,
    '',
    'PROPOSAL:',
    JSON.stringify(
      {
        title: proposal.title,
        dueAt: proposal.dueAt,
        splitInto: proposal.ambiguityFlags.includes('multiple_commitments') ? '>1' : 1,
      },
      null,
      2,
    ),
    '',
    'Answer with one JSON object and nothing else:',
    '{"agrees": boolean, "correctedSplit": number|null, "correctedTimes": string[], "note": string|null}',
    'correctedSplit is how many separate commitments the text really contains.',
    'correctedTimes are 24-hour HH:MM strings, in the order the commitments appear.',
    'Set agrees to true when the proposal is right; leave the corrections null and empty.',
  ].join('\n');
}

export function parseArbitrationVerdict(raw: string): ArbitrationVerdict {
  try {
    const parsed = JSON.parse(raw) as Partial<ArbitrationVerdict>;
    // A reply that does not answer the one question asked is no answer at all.
    if (typeof parsed.agrees !== 'boolean') return UNAVAILABLE;
    return {
      agrees: parsed.agrees,
      // Derived here, never read off the wire: the remote model does not get
      // to label its own correction an agreement.
      outcome: parsed.agrees ? 'agreed' : 'disagreed',
      correctedSplit:
        typeof parsed.correctedSplit === 'number' ? parsed.correctedSplit : null,
      correctedTimes: Array.isArray(parsed.correctedTimes)
        ? parsed.correctedTimes.filter((t): t is string => typeof t === 'string')
        : [],
      note: typeof parsed.note === 'string' ? parsed.note : null,
    };
  } catch {
    // A model that answered with prose has not disagreed with anything -- but
    // it has not agreed either.
    return UNAVAILABLE;
  }
}

export function createAnthropicArbiter(client: {
  messages: { create: Function };
}): ArbiterFunction {
  return async (rawText, proposal) => {
    // Same boundary as the local path. Escalation must not route around it.
    if (screenForInjection(rawText) !== null) return UNAVAILABLE;

    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        messages: [{ role: 'user', content: buildArbiterPrompt(rawText, proposal) }],
      });
      const block = (response.content ?? []).find(
        (b: { type: string }) => b.type === 'text',
      );
      return parseArbitrationVerdict(block?.text ?? '');
    } catch {
      // The remote model is an improvement, never a dependency.
      return UNAVAILABLE;
    }
  };
}
