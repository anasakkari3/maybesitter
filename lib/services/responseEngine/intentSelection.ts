import type {
  CommunicativeIntent,
  ResponseStrategy,
  RhetoricalMove,
  SemanticEvent,
  ToneStage,
  UserSituationAnalysis,
} from './assistantTurn';
import type { CommitmentConversationState, ConversationLevelState } from './conversationStateStore';

export type IntentSelection = {
  intent: CommunicativeIntent;
  supportIntent?: CommunicativeIntent;
  strategy: ResponseStrategy;
  moves: RhetoricalMove[];
  tone: ToneStage;
  maxSentences: 1 | 2;
  requireQuestion: boolean;
};

function rotateStrategy(strategy: ResponseStrategy): ResponseStrategy {
  if (strategy === 'easy_choice') return 'smaller_step';
  if (strategy === 'smaller_step') return 'blocker_probe';
  if (strategy === 'blocker_probe') return 'reset_plan';
  if (strategy === 'reset_plan') return 'close_loop';
  return 'easy_choice';
}

function pressureStrategy(input: {
  event: Extract<SemanticEvent, { type: 'pressure_due' }>;
  situation: UserSituationAnalysis;
  conversationState: ConversationLevelState;
  commitmentState?: CommitmentConversationState;
}): Pick<IntentSelection, 'intent' | 'strategy' | 'moves' | 'tone' | 'maxSentences' | 'requireQuestion'> {
  const pressureCount = input.commitmentState?.pressureCount || 0;
  const ignored = Boolean(input.event.ignoredText);
  let strategy: ResponseStrategy = 'easy_choice';

  if (pressureCount >= 3) strategy = 'close_loop';
  else if (pressureCount >= 2 || input.situation.situation === 'avoiding') strategy = 'blocker_probe';
  else if (pressureCount >= 1 || ignored || input.situation.situation === 'possibly_overloaded') strategy = 'smaller_step';
  else if (input.situation.situation === 'deferring') strategy = 'reset_plan';

  if (input.commitmentState?.lastStrategy === strategy) strategy = rotateStrategy(strategy);

  if (strategy === 'blocker_probe') {
    return { intent: 'probe_blocker', strategy, moves: ['name_continuity', 'probe_blocker'], tone: 'direct', maxSentences: 2, requireQuestion: true };
  }
  if (strategy === 'reset_plan') {
    return { intent: 'reset_plan', strategy, moves: ['name_continuity', 'offer_reset'], tone: 'firm', maxSentences: 2, requireQuestion: false };
  }
  if (strategy === 'smaller_step') {
    return { intent: 'nudge', strategy, moves: ['name_continuity', 'offer_small_step'], tone: 'direct', maxSentences: 2, requireQuestion: false };
  }
  if (strategy === 'close_loop') {
    return { intent: 'escalate_choice', strategy, moves: ['name_continuity', 'force_choice'], tone: 'firm', maxSentences: 2, requireQuestion: false };
  }
  return { intent: 'nudge', strategy, moves: ['name_continuity', 'offer_small_step'], tone: 'light_check', maxSentences: 2, requireQuestion: true };
}

export function selectIntent(input: {
  event: SemanticEvent;
  situation: UserSituationAnalysis;
  conversationState: ConversationLevelState;
  commitmentState?: CommitmentConversationState;
}): IntentSelection {
  switch (input.event.type) {
    case 'reminder_created':
    case 'commitment_moved':
    case 'commitment_updated':
    case 'commitment_cancelled':
    case 'commitment_acknowledged':
      return { intent: 'confirm_result', strategy: 'direct_result', moves: ['confirm_action'], tone: 'quiet', maxSentences: 1, requireQuestion: false };
    case 'commitment_completed':
      return { intent: 'close_loop', strategy: 'direct_result', moves: ['close_loop'], tone: input.situation.situation === 'recovering' ? 'recovery' : 'quiet', maxSentences: 1, requireQuestion: false };
    case 'needs_clarification':
      return { intent: 'clarify_missing_detail', strategy: 'focused_question', moves: ['ask_missing_detail'], tone: input.conversationState.fatigue === 'high' ? 'direct' : 'quiet', maxSentences: input.event.missing === 'action' && (input.event.remindAt || input.event.dueAt) ? 2 : 1, requireQuestion: true };
    case 'confirmation_needed':
      return { intent: 'request_confirmation', strategy: 'careful_confirm', moves: ['ask_confirmation'], tone: 'quiet', maxSentences: 1, requireQuestion: true };
    case 'informational_no_change':
      return { intent: 'acknowledge_no_change', strategy: 'context_boundary', moves: ['acknowledge_without_action'], tone: 'quiet', maxSentences: 1, requireQuestion: false };
    case 'multi_commitment_result':
      return { intent: 'confirm_result', strategy: 'multi_summary', moves: ['summarize_multiple'], tone: 'quiet', maxSentences: 2, requireQuestion: false };
    case 'pressure_due':
      return pressureStrategy(input as {
        event: Extract<SemanticEvent, { type: 'pressure_due' }>;
        situation: UserSituationAnalysis;
        conversationState: ConversationLevelState;
        commitmentState?: CommitmentConversationState;
      });
  }
}
