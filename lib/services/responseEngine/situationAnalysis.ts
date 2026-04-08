import type { CommitmentConversationState, ConversationLevelState } from './conversationStateStore';
import type { SemanticEvent, UserSituationAnalysis, UserSituationReason } from './assistantTurn';

export function analyzeUserSituation(input: {
  event: SemanticEvent;
  conversationState: ConversationLevelState;
  commitmentState?: CommitmentConversationState;
}): UserSituationAnalysis {
  const reasonCodes: UserSituationReason[] = [];

  if (input.event.type === 'needs_clarification') reasonCodes.push('ambiguous_input');
  if (input.conversationState.recentClarificationCount >= 2) reasonCodes.push('ambiguous_input');
  if ((input.commitmentState?.pressureCount || 0) >= 2) reasonCodes.push('missed_same_commitment');
  if ((input.commitmentState?.ignoredCount || 0) >= 2) reasonCodes.push('missed_same_commitment');
  if (input.conversationState.recentDeferralCount >= 2) reasonCodes.push('repeated_postpone');
  if (input.conversationState.fatigue === 'high') reasonCodes.push('many_open_items');
  if (input.conversationState.recentCompletionCount > 0) reasonCodes.push('recent_completion');
  if (input.conversationState.recentNoResponseCount > 0) reasonCodes.push('recent_no_response');

  if (input.event.type === 'commitment_completed' || input.event.type === 'commitment_moved') {
    return {
      situation: input.commitmentState?.pressureState && input.commitmentState.pressureState !== 'idle' ? 'recovering' : 'clear_and_decisive',
      confidence: 'medium',
      reasonCodes: reasonCodes.includes('recent_completion') ? reasonCodes : [...reasonCodes, 'recent_completion'],
    };
  }

  if (input.event.type === 'needs_clarification') {
    return {
      situation: 'needs_clarity',
      confidence: reasonCodes.length > 1 ? 'high' : 'medium',
      reasonCodes,
    };
  }

  if (input.event.type === 'pressure_due') {
    if ((input.commitmentState?.pressureCount || 0) >= 2 || (input.commitmentState?.ignoredCount || 0) >= 2) {
      return { situation: 'avoiding', confidence: 'medium', reasonCodes };
    }
    if (input.conversationState.recentDeferralCount >= 2) {
      return { situation: 'deferring', confidence: 'medium', reasonCodes };
    }
    if (input.conversationState.fatigue !== 'low') {
      return { situation: 'possibly_overloaded', confidence: 'low', reasonCodes };
    }
  }

  return {
    situation: 'clear_and_decisive',
    confidence: 'low',
    reasonCodes,
  };
}
