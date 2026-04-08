import { formatDisplayTime } from './displayTime';
import { normalizePhrases } from './phraseNormalization';
import { selectIntent } from './intentSelection';
import type { ResponsePlan, SemanticEvent, UserSituationAnalysis } from './assistantTurn';
import type { CommitmentConversationState, ConversationLevelState } from './conversationStateStore';

export type BuildResponsePlanInput = {
  event: SemanticEvent;
  situation: UserSituationAnalysis;
  conversationState: ConversationLevelState;
  commitmentState?: CommitmentConversationState;
  now?: Date;
};

const BASE_FORBIDDEN_TERMS = [
  'Tracking',
  'Drafted',
  'Executed',
  "You're set",
  'disposition',
  'command',
  'avoidant',
  'inconsistent',
];

function stateChangeFor(event: SemanticEvent): ResponsePlan['facts']['stateChange'] {
  switch (event.type) {
    case 'reminder_created':
      return 'created';
    case 'commitment_completed':
      return 'completed';
    case 'commitment_moved':
      return 'moved';
    case 'commitment_cancelled':
      return 'cancelled';
    case 'commitment_updated':
      return 'updated';
    case 'commitment_acknowledged':
      return 'acknowledged';
    case 'informational_no_change':
      return 'none';
    default:
      return undefined;
  }
}

function timeFor(event: SemanticEvent, now?: Date): string | undefined {
  if (event.type === 'reminder_created') return formatDisplayTime(event.remindAt || event.dueAt, now) || undefined;
  if (event.type === 'commitment_moved') return formatDisplayTime(event.movedTo, now) || undefined;
  if (event.type === 'commitment_updated') return formatDisplayTime(event.time, now) || undefined;
  if (event.type === 'needs_clarification') return formatDisplayTime(event.remindAt || event.dueAt, now) || undefined;
  return undefined;
}

function continuityText(event: SemanticEvent): string | undefined {
  if (event.type !== 'pressure_due') return undefined;
  if (event.ignoredText) return `${event.title} has come back ${event.ignoredText}`;
  if (event.overdueText) return `${event.title} has been waiting ${event.overdueText}`;
  return `${event.title} is still open`;
}

export function buildResponsePlan(input: BuildResponsePlanInput): ResponsePlan {
  const selection = selectIntent(input);
  const event = input.event;
  const title = 'title' in event ? event.title : undefined;
  const timeText = timeFor(event, input.now);
  const phrases = normalizePhrases({ title, timeText });

  return {
    intent: selection.intent,
    supportIntent: selection.supportIntent,
    strategy: selection.strategy,
    moves: selection.moves,
    facts: {
      title: phrases.title,
      titleLower: phrases.titleLower,
      titleCapitalized: phrases.titleCapitalized,
      titleKind: phrases.titleKind,
      reminderObject: phrases.reminderObject,
      reminderNoun: phrases.reminderNoun,
      contextClause: phrases.contextClause,
      timeText: phrases.timeText,
      timeWithPreposition: phrases.timeWithPreposition,
      stateChange: stateChangeFor(event),
      noChangeReason: event.type === 'informational_no_change' ? event.reason || 'informational' : undefined,
      missing: event.type === 'needs_clarification' ? event.missing : undefined,
      continuityText: continuityText(event),
      scheduledTitles: event.type === 'multi_commitment_result' ? event.scheduledTitles : undefined,
      reviewTitles: event.type === 'multi_commitment_result' ? event.reviewTitles : undefined,
      savedCount: event.type === 'multi_commitment_result' ? event.savedCount : undefined,
      totalCount: event.type === 'multi_commitment_result' ? event.totalCount : undefined,
      needsClarification: event.type === 'multi_commitment_result' ? event.needsClarification : undefined,
    },
    constraints: {
      tone: selection.tone,
      maxSentences: selection.maxSentences,
      requireQuestion: selection.requireQuestion,
      forbiddenTerms: BASE_FORBIDDEN_TERMS,
    },
  };
}
