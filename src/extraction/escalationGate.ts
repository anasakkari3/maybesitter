import type { ExtractionResult } from './extractionTypes';

export type EscalationReason =
  | 'multiple_commitments'
  | 'low_time_confidence'
  | 'low_overall_confidence'
  | 'unresolved_reference';

export interface EscalationDecision {
  escalate: boolean;
  reasons: EscalationReason[];
}

/**
 * PROVISIONAL. These two numbers are not calibrated from a measurement yet.
 *
 * The Task 1 baseline they were meant to come from ran on 8 seed cases, not
 * the 50 the plan calls for -- the 42 owner-authored dialect sentences do not
 * exist. What that run did produce (evaluation-reports/dialect-baseline.json,
 * 2026-08-21): gemma3:4b 5/8 overall, 3/4 Arabic, 2/2 Hebrew, 0/2 English;
 * guoxuter/ov_intent_analysis_sft:v7_q8 and qwen3.5:9b both 0/8, because
 * callOllama reads only Ollama's `response` field and those two are thinking
 * models that answer in `thinking` -- a harness gap, not a dialect result.
 * Four Arabic cases cannot calibrate anything, so these values are a starting
 * point to be replaced once the owner dataset lands and the harness reads
 * thinking models correctly.
 *
 * Raising these escalates more and costs more; lowering them ships more of
 * the local model's guesses unchecked.
 */
export const ESCALATION_THRESHOLDS = { time: 0.6, overall: 0.7 };

/**
 * References a lexicon cannot resolve: a pronoun or a comparison to an
 * earlier commitment. The local model will happily produce a confident
 * answer for these, which is exactly why confidence alone is not enough.
 */
const UNRESOLVED_REFERENCE = new RegExp(
  [
    'عليها|عليه|معها|معه|عندها|عنده',
    'نفس (الموعد|الوقت|الساعة)',
    'زي (المرة|الأسبوع) (الماضية|الماضي)',
    'אותה שעה|כמו בשבוע שעבר|אצלה|אצלו',
    '\\b(same (time|place) as|like last (week|time)|her|him|there)\\b',
  ].join('|'),
  'i',
);

export function decideEscalation(
  result: ExtractionResult,
  rawText: string,
): EscalationDecision {
  const reasons: EscalationReason[] = [];

  // Splitting is the decision the user notices most and the local model is
  // weakest at, so this one escalates regardless of how confident it sounds.
  if (result.ambiguityFlags.includes('multiple_commitments')) {
    reasons.push('multiple_commitments');
  }
  if (result.confidence.time < ESCALATION_THRESHOLDS.time) {
    reasons.push('low_time_confidence');
  }
  if (result.confidence.overall < ESCALATION_THRESHOLDS.overall) {
    reasons.push('low_overall_confidence');
  }
  if (UNRESOLVED_REFERENCE.test(rawText)) {
    reasons.push('unresolved_reference');
  }

  return { escalate: reasons.length > 0, reasons };
}
