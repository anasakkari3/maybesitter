import type { MemoryCandidate, CandidateModality, CandidatePrecision } from '../domain/memory/memoryTypes.ts';

interface RuleBasedCandidateContext {
  now: Date;
  timezone?: string;
}

function mk(alternatives: string[]): RegExp {
  return new RegExp(`(?:${alternatives.join('|')})`, 'i');
}

const CERTAIN_PATTERNS = mk([
  'خلص',
  'اتفقنا',
  'أكيد',
  'مأكد',
  'رايح',
  'ذكرني',
  'remind me',
  'I will',
  "I'm going to",
  'for sure',
  'definitely',
  'תזכיר\\s+לי',
  'בטוח',
]);

const INTENDED_PATTERNS = mk([
  'ناوي',
  'بدي',
  'عازم',
  'I plan to',
  'I intend to',
  'going to',
  'מתכנן',
]);

const POSSIBLE_PATTERNS = mk([
  'يمكن',
  'ممكن',
  'بلكي',
  'maybe',
  'perhaps',
  'might',
  'possibly',
  'אולי',
  'יכול\\s+להיות',
]);

const CONDITIONAL_PATTERNS = mk([
  'إذا',
  'لو',
  'if',
  'unless',
  'אם',
]);

const NEGATION_PATTERNS = mk([
  'مش',
  'ما\\s+رح',
  'بطلت',
  'لا تذكرني',
  'كنت\\s+(?:بدي|ناوي)\\s+.*بس\\s+بطلت',
  "won't",
  "don't",
  'not going',
  'cancel',
  'לא',
  'ביטלתי',
]);

const REPORTED_PATTERNS = mk([
  'قال(?:ت|وا)?\\s+(?:إن|أن)',
  'حكى\\s+(?:إن|أن)',
  'أمي\\s+قالت',
  'said\\s+(?:that|they)',
  'told\\s+me',
  'אמר',
  'אמרה',
]);

function detectModality(text: string): CandidateModality {
  // Order matters: hedges and negations must take precedence over embedded
  // certainty markers (e.g. "maybe I will" is possible, not certain).
  if (NEGATION_PATTERNS.test(text)) return 'negated';
  if (REPORTED_PATTERNS.test(text)) return 'reported';
  if (CONDITIONAL_PATTERNS.test(text)) return 'conditional';
  if (POSSIBLE_PATTERNS.test(text)) return 'possible';
  if (INTENDED_PATTERNS.test(text)) return 'intended';
  if (CERTAIN_PATTERNS.test(text)) return 'certain';
  return 'possible';
}

function confidenceForModality(modality: CandidateModality): number {
  switch (modality) {
    case 'certain': return 0.90;
    case 'intended': return 0.78;
    case 'possible': return 0.55;
    case 'conditional': return 0.45;
    case 'negated': return 0.92;
    case 'reported': return 0.60;
  }
}

const TIME_PATTERNS: { pattern: RegExp; precision: CandidatePrecision }[] = [
  { pattern: mk(['بكرا', 'بكره', 'tomorrow', 'מחר']), precision: 'day' },
  { pattern: mk(['الأسبوع\\s+الجاي', 'next\\s+week', 'שבוע\\s+הבא']), precision: 'day' },
  { pattern: mk(['الساعة\\s+\\d{1,2}', 'at\\s+\\d{1,2}', 'בשעה\\s+\\d{1,2}']), precision: 'exact' },
  { pattern: mk(['الخميس', 'Thursday', 'יום\\s+חמישי']), precision: 'day' },
  { pattern: mk(['الجمعة', 'Friday', 'יום\\s+שישי']), precision: 'day' },
  { pattern: mk(['بعد\\s+بكرا', 'day\\s+after\\s+tomorrow', 'מחרתיים']), precision: 'day' },
  { pattern: mk(['اليوم', 'today', 'היום']), precision: 'day' },
];

function extractTemporal(text: string): MemoryCandidate['temporal'] | undefined {
  for (const { pattern, precision } of TIME_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return {
        rawText: match[0],
        precision,
      };
    }
  }
  return undefined;
}

export function extractCandidatesRuleBased(text: string, _context: RuleBasedCandidateContext): MemoryCandidate[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const modality = detectModality(trimmed);

  if (modality === 'negated') {
    return [{
      candidateType: 'commitment',
      normalizedText: trimmed,
      modality: 'negated',
      confidence: confidenceForModality('negated'),
      temporal: extractTemporal(trimmed),
      evidenceSpan: { start: 0, end: trimmed.length, text: trimmed },
    }];
  }

  const candidate: MemoryCandidate = {
    candidateType: 'commitment',
    normalizedText: trimmed,
    modality,
    confidence: confidenceForModality(modality),
    temporal: extractTemporal(trimmed),
    evidenceSpan: { start: 0, end: trimmed.length, text: trimmed },
  };

  return [candidate];
}
