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
 * exist. What that run produced (evaluation-reports/dialect-baseline.json,
 * regenerated 2026-08-21 after two harness bugs were fixed): all three
 * candidates -- guoxuter/ov_intent_analysis_sft:v7_q8, gemma3:4b and
 * qwen3.5:9b -- score 3/4 on Arabic. The seed set does not separate them.
 *
 * Do not cite the earlier version of that report: it showed two models at 0/8,
 * which measured a client that never sent think:false and a time comparison
 * that scored local wall-clock against UTC.
 *
 * Four Arabic sentences cannot calibrate anything, so these values are a
 * starting point to be replaced once the owner dataset lands.
 *
 * Raising these escalates more and costs more; lowering them ships more of
 * the local model's guesses unchecked.
 */
export const ESCALATION_THRESHOLDS = { time: 0.6, overall: 0.7 };

/**
 * A reference the model cannot resolve from the sentence alone, because
 * resolving it needs history the model does not have: a comparison to an
 * earlier commitment, or somebody's place standing in for an address. The
 * local model will happily answer these with high confidence, which is
 * exactly why confidence alone is not enough.
 *
 * Two things this deliberately does NOT match, both measured false positives:
 *
 * - Bare English pronouns (`her`, `him`, `there`). Unlike the Arabic clitics
 *   below they carry no destination: the place is named elsewhere in the
 *   sentence ("pick her up from school"), so they change no extracted field,
 *   and `there` is usually an expletive subject ("remind me there is a
 *   dentist..."). Including them escalated 7 of 11 ordinary captures, against
 *   a design whose whole premise is that only doubtful captures cost anything.
 * - Arabic and Hebrew attached pronouns as substrings. JS `\b` is ASCII-only
 *   and does nothing here, so `عنده` matched inside `عندهم` and `معه` inside
 *   `الجامعه`. The lookarounds below are the working equivalent.
 */
const ARABIC_OR_HEBREW = '\u0590-\u05FF\u0600-\u06FF';
const UNRESOLVED_REFERENCE = new RegExp(
  [
    // A person standing in for a place the sentence never names. These are
    // preposition+clitic forms -- "بمرّ عليها" is "I'll pass by hers" -- so
    // unlike a bare English object pronoun they carry a destination.
    `(?<![${ARABIC_OR_HEBREW}])(عليها|عليه|معها|معه|عندها|عنده|אצלה|אצלו)(?![${ARABIC_OR_HEBREW}])`,
    // A comparison to an earlier commitment. The noun takes the definite
    // article or the construct state -- the plan's own ar-3 fixture,
    // "نفس موعد الأسبوع الماضي", is the construct state and has no ال.
    'نفس\\s+(ال)?(موعد|وقت|ساعة|مكان)',
    'زي (المرة|الأسبوع) (الماضية|الماضي)',
    'אותה שעה|כמו בשבוע שעבר',
    '\\b(same (time|place) as|like last (week|time))\\b',
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
