export type PhraseKind = 'action' | 'noun' | 'context';

export type NormalizedPhrases = {
  title?: string;
  titleLower?: string;
  titleCapitalized?: string;
  titleKind: PhraseKind;
  reminderObject: string;
  reminderNoun: string;
  contextClause?: string;
  timeText?: string;
  timeWithPreposition?: string;
};

const ACTION_VERBS = /^(call|text|email|message|follow up|send|pay|book|schedule|submit|finish|review|check|pick up|buy|renew|reply|read)\b/i;

function clean(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function capitalFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function smoothCommonArticles(value: string): string {
  return value
    .replace(/\babout lease\b/i, 'about the lease')
    .replace(/\babout invoice\b/i, 'about the invoice')
    .replace(/\babout bill\b/i, 'about the bill');
}

export function phraseKindForTitle(title: string | undefined): PhraseKind {
  if (!title) return 'noun';
  if (/\b(is|are|was|were|waiting|blocked|stuck|needs|need)\b/i.test(title) && !ACTION_VERBS.test(title)) return 'context';
  if (ACTION_VERBS.test(title)) return 'action';
  return 'noun';
}

export function normalizeTimePhrase(timeText: string | undefined): { timeText?: string; timeWithPreposition?: string } {
  const normalized = clean(timeText);
  if (!normalized) return {};
  const needsPreposition = !/^(today|tomorrow|tonight|this|next|on\b|at\b|in\b|by\b|for\b|Apr\b|May\b|Jun\b|Jul\b|Aug\b|Sep\b|Oct\b|Nov\b|Dec\b|Jan\b|Feb\b|Mar\b)/i.test(normalized);
  return {
    timeText: normalized,
    timeWithPreposition: needsPreposition ? `at ${normalized}` : normalized,
  };
}

export function normalizePhrases(input: { title?: string; timeText?: string }): NormalizedPhrases {
  const rawTitle = clean(input.title);
  const smoothed = rawTitle ? smoothCommonArticles(rawTitle) : undefined;
  const kind = phraseKindForTitle(smoothed);
  const time = normalizeTimePhrase(input.timeText);
  const titleLower = smoothed ? lowerFirst(smoothed) : undefined;
  const titleCapitalized = smoothed ? capitalFirst(smoothed) : undefined;

  return {
    title: smoothed,
    titleLower,
    titleCapitalized,
    titleKind: kind,
    reminderObject: smoothed
      ? kind === 'action' ? `to ${titleLower}` : `about ${titleLower}`
      : 'that',
    reminderNoun: smoothed
      ? kind === 'action' ? `${titleLower} reminder` : `reminder for ${titleLower}`
      : 'reminder',
    contextClause: kind === 'context' ? smoothed : undefined,
    ...time,
  };
}
