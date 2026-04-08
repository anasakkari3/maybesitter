export type AssistantVerbosity = 'low';
export type AssistantTone = 'calm_firm';
export type AssistantQuestioningStyle = 'focused';

export interface AssistantPersonality {
  style: {
    verbosity: AssistantVerbosity;
    tone: AssistantTone;
    questioningStyle: AssistantQuestioningStyle;
  };
}

export type AssistantCopyIntent =
  | 'interpretation'
  | 'context'
  | 'no_change'
  | 'no_action'
  | 'action_done'
  | 'clean_end'
  | 'confirm'
  | 'clarification_unresolved'
  | 'review';

const PERSONALITY: AssistantPersonality = Object.freeze({
  style: Object.freeze({
    verbosity: 'low',
    tone: 'calm_firm',
    questioningStyle: 'focused',
  }),
});

const COPY: Record<AssistantCopyIntent, string> = Object.freeze({
  interpretation: 'Tracking',
  context: 'Noted',
  no_change: 'No reminder created.',
  no_action: 'No changes made.',
  action_done: 'Saved.',
  clean_end: "You're set.",
  confirm: 'Should I save this reminder?',
  clarification_unresolved: 'I need one clearer detail before changing anything.',
  review: 'Please review before I change anything.',
});

const FILLER_PATTERNS = [
  /\bjust checking in\b/i,
  /\bhope (you'?re|you are) doing well\b/i,
  /\bno worries\b/i,
  /\bsounds good\b/i,
  /\bawesome\b/i,
  /\bgreat\b/i,
];

const SYSTEM_LIKE_PATTERNS = [
  /\bexecuted commands?\b/i,
  /\bdisposition\b/i,
  /\bengine used\b/i,
  /\braw output\b/i,
  /\bdebug meta\b/i,
];

function normalizeCopy(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function getAssistantPersonality(): AssistantPersonality {
  return PERSONALITY;
}

export function assistantCopy(intent: AssistantCopyIntent): string {
  return COPY[intent];
}

export function isAssistantCopyAllowed(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = normalizeCopy(value);
  if (!text) return false;
  if (FILLER_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return !SYSTEM_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}
