import type { MemoryCandidate, CandidatePrecision } from '../domain/memory/memoryTypes.ts';

export interface MemoryCandidateExtractionResult {
  candidates: MemoryCandidate[];
  language: 'ar' | 'he' | 'en' | 'mixed';
}

export function validateMemoryCandidate(raw: unknown): MemoryCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const validTypes = ['commitment', 'fact', 'preference', 'hypothesis', 'none'];
  if (!validTypes.includes(obj.candidateType as string)) return null;

  const validModalities = ['certain', 'intended', 'possible', 'conditional', 'negated', 'reported'];
  if (!validModalities.includes(obj.modality as string)) return null;

  if (typeof obj.normalizedText !== 'string' || !obj.normalizedText) return null;
  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) return null;

  if (!obj.evidenceSpan || typeof obj.evidenceSpan !== 'object') return null;
  const span = obj.evidenceSpan as Record<string, unknown>;
  if (typeof span.start !== 'number' || typeof span.end !== 'number' || typeof span.text !== 'string') return null;

  const candidate: MemoryCandidate = {
    candidateType: obj.candidateType as MemoryCandidate['candidateType'],
    normalizedText: obj.normalizedText as string,
    modality: obj.modality as MemoryCandidate['modality'],
    confidence: obj.confidence as number,
    evidenceSpan: {
      start: span.start as number,
      end: span.end as number,
      text: span.text as string,
    },
  };

  if (obj.temporal && typeof obj.temporal === 'object') {
    const temporal = obj.temporal as Record<string, unknown>;
    if (typeof temporal.rawText === 'string') {
      const validPrecisions = ['none', 'day', 'approximate', 'exact'];
      candidate.temporal = {
        rawText: temporal.rawText as string,
        resolvedAt: typeof temporal.resolvedAt === 'string' ? temporal.resolvedAt : undefined,
        precision: validPrecisions.includes(temporal.precision as string)
          ? (temporal.precision as CandidatePrecision)
          : 'none',
      };
    }
  }

  return candidate;
}

export function validateMemoryCandidateResult(raw: unknown): MemoryCandidateExtractionResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.candidates)) return null;

  const validLanguages = ['ar', 'he', 'en', 'mixed'];
  const language = validLanguages.includes(obj.language as string)
    ? (obj.language as 'ar' | 'he' | 'en' | 'mixed')
    : 'en';

  const candidates: MemoryCandidate[] = [];
  for (const rawCandidate of obj.candidates) {
    const validated = validateMemoryCandidate(rawCandidate);
    if (validated) candidates.push(validated);
  }

  return { candidates, language };
}
