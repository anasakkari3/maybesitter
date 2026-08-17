import type {
  MemoryCandidate,
  CommitmentMemoryStatus,
  NotificationDecision,
  NotificationReasonCode,
  CommitmentMemory,
  PreferenceStrength,
  PreferencePolarity,
} from './memoryTypes.ts';

export function classifyCommitmentStatus(candidate: MemoryCandidate): CommitmentMemoryStatus | null {
  if (candidate.candidateType !== 'commitment') return null;

  switch (candidate.modality) {
    case 'possible':
    case 'conditional':
      return 'mentioned';
    case 'intended':
      return 'proposed';
    case 'certain':
      return candidate.temporal?.resolvedAt ? 'scheduled' : 'confirmed';
    case 'negated':
      return null;
    case 'reported':
      return 'mentioned';
  }
}

export type ConfirmationLevel = 'auto_accept' | 'soft_confirmation' | 'hard_confirmation';

export function decideConfirmationLevel(candidate: MemoryCandidate): ConfirmationLevel {
  if (candidate.modality === 'certain' && candidate.confidence >= 0.90) {
    return 'auto_accept';
  }
  if (candidate.modality === 'intended' || (candidate.modality === 'certain' && candidate.confidence < 0.90)) {
    return 'soft_confirmation';
  }
  return 'hard_confirmation';
}

export function evaluateNotificationEligibility(commitment: CommitmentMemory): NotificationDecision {
  const reasons: NotificationReasonCode[] = [];

  if (!['confirmed', 'scheduled'].includes(commitment.status)) {
    reasons.push('STATUS_NOT_CONFIRMED');
  }
  if (!commitment.dueAt) {
    reasons.push('MISSING_TIME');
  }
  if (commitment.confidence < 0.85) {
    reasons.push('LOW_CONFIDENCE');
  }
  if (commitment.requiresConfirmation) {
    reasons.push('USER_CONFIRMATION_REQUIRED');
  }

  if (reasons.length > 0) {
    return { eligible: false, reasonCodes: reasons };
  }

  return {
    eligible: true,
    scheduledAt: commitment.dueAt,
    reasonCodes: ['ELIGIBLE'],
  };
}

function mkPolicyPattern(alternatives: string[]): RegExp {
  return new RegExp(`(?:${alternatives.join('|')})`, 'i');
}

const HARD_STRENGTH_PATTERNS = mkPolicyPattern([
  '\\balways\\b', '\\bnever\\b', '\\bmust\\b', 'دايماً', 'دائما', 'لازم', 'תמיד', 'אף\\s+פעם',
]);

const AVOID_POLARITY_PATTERNS = mkPolicyPattern([
  "don't\\s+like", '\\bavoid\\b', '\\bhate\\b', 'ما\\s+بحب', 'مش\\s+بحب', 'לא\\s+אוהב',
]);

export function classifyPreferenceStrength(candidate: MemoryCandidate): PreferenceStrength {
  return HARD_STRENGTH_PATTERNS.test(candidate.normalizedText) ? 'hard' : 'soft';
}

export function classifyPreferencePolarity(candidate: MemoryCandidate): PreferencePolarity {
  return AVOID_POLARITY_PATTERNS.test(candidate.normalizedText) ? 'avoid' : 'prefer';
}

/**
 * Small closed vocabulary, not open-domain topic extraction — consistent with the
 * rule-based (no ML, no vector DB) extraction approach used throughout Sprint 1.
 * Falls back to the normalized statement text, which simply will not match any
 * commitment title later (fails safe: no scope match means no arm effect).
 */
const SCOPE_KEYWORDS: Record<string, string> = {
  'جيم': 'gym', gym: 'gym',
  wolt: 'wolt', 'وولت': 'wolt',
  // 'بشتغل' (not just 'شغل') because the colloquial present-tense conjugation
  // inserts a ت between the ب prefix and the شغل root — 'شغل' alone is not a
  // substring of 'بشتغل', so an "I work" statement would otherwise match nothing.
  'بشتغل': 'work', 'شغل': 'work', 'دوام': 'work', work: 'work', shift: 'work',
  'نوم': 'sleep', sleep: 'sleep',
  // Hebrew. The extractor already detects Hebrew preferences ("אני מעדיף") and facts
  // ("אני עובד"), so without these entries every Hebrew statement fell through to the
  // full-text fallback scope, which never substring-matches a commitment title —
  // Hebrew was a silent no-op on arm scoring. 'עובד'/'עובדת' (the inflected verb) are
  // listed alongside the noun 'עבודה' for the same reason 'بشتغل' is listed alongside
  // 'شغل': "אני עובד ביום שלישי" contains neither 'עבודה' nor 'משמרת'.
  'חדר כושר': 'gym', 'כושר': 'gym', 'ג׳ים': 'gym', "ג'ים": 'gym',
  'עבודה': 'work', 'משמרת': 'work', 'עובדת': 'work', 'עובד': 'work',
  'שינה': 'sleep', 'לישון': 'sleep',
};

export function deriveStatementScope(candidate: MemoryCandidate): string {
  const normalized = candidate.normalizedText.toLowerCase();
  for (const [keyword, scope] of Object.entries(SCOPE_KEYWORDS)) {
    if (normalized.includes(keyword.toLowerCase())) return scope;
  }
  return normalized;
}
