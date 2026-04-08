import { buildResponsePlan, type BuildResponsePlanInput } from './responsePlanning';
import { realizeResponsePlan, type RealizationOptions } from './realization';
import { analyzeUserSituation } from './situationAnalysis';
import { validateResponsePlanAndMessage } from './validation';
import {
  getConversationStateStore,
  type CommitmentConversationState,
  type ConversationLevelState,
  type ConversationStateStore,
} from './conversationStateStore';

export type SemanticEvent =
  | { type: 'reminder_created'; title?: string; remindAt?: string | null; dueAt?: string | null }
  | { type: 'needs_clarification'; missing: 'time' | 'action' | 'person' | 'unknown'; title?: string; remindAt?: string | null; dueAt?: string | null }
  | { type: 'confirmation_needed'; title?: string }
  | { type: 'informational_no_change'; title?: string; reason?: 'informational' | 'unsafe' | 'expired' | 'ambiguous' }
  | { type: 'commitment_completed'; title?: string; confirmedInSameFlow?: boolean }
  | { type: 'commitment_acknowledged'; title?: string }
  | { type: 'commitment_moved'; title?: string; movedTo?: string | null; confirmedInSameFlow?: boolean }
  | { type: 'commitment_cancelled'; title?: string }
  | { type: 'commitment_updated'; title?: string; time?: string | null }
  | { type: 'multi_commitment_result'; savedCount: number; totalCount: number; scheduledTitles: string[]; reviewTitles: string[]; needsClarification: number; hadExecutionNotes: boolean }
  | { type: 'pressure_due'; commitmentId: string; title: string; overdueText?: string | null; ignoredText?: string | null; kind?: 'task' | 'follow_up' };

export type CommunicativeIntent =
  | 'confirm_result'
  | 'clarify_missing_detail'
  | 'request_confirmation'
  | 'acknowledge_no_change'
  | 'close_loop'
  | 'nudge'
  | 'probe_blocker'
  | 'reset_plan'
  | 'escalate_choice';

export type ResponseStrategy =
  | 'direct_result'
  | 'focused_question'
  | 'careful_confirm'
  | 'context_boundary'
  | 'easy_choice'
  | 'smaller_step'
  | 'blocker_probe'
  | 'reset_plan'
  | 'close_loop'
  | 'multi_summary';

export type RhetoricalMove =
  | 'confirm_action'
  | 'ask_missing_detail'
  | 'ask_confirmation'
  | 'acknowledge_without_action'
  | 'name_continuity'
  | 'offer_small_step'
  | 'probe_blocker'
  | 'offer_reset'
  | 'force_choice'
  | 'close_loop'
  | 'summarize_multiple';

export type RealizationPath =
  | 'assistant_commitment'
  | 'task_set_for_time'
  | 'done_assistant_commitment'
  | 'time_first_commitment'
  | 'reminder_ready'
  | 'direct_question'
  | 'context_question'
  | 'known_time_question'
  | 'specific_missing_question'
  | 'careful_confirmation'
  | 'proposed_change_question'
  | 'boundary_ack'
  | 'context_boundary'
  | 'plain_no_change'
  | 'done_state'
  | 'item_state_closure'
  | 'assistant_closed'
  | 'moved_by_assistant'
  | 'cancelled_by_assistant'
  | 'continuity_choice'
  | 'continuity_small_step'
  | 'continuity_blocker'
  | 'continuity_reset'
  | 'decision_close'
  | 'pressure_decision_choice'
  | 'pressure_decision_reset'
  | 'pressure_time_choice'
  | 'pressure_direct_small_step'
  | 'pressure_blocker_first'
  | 'pressure_reset_first'
  | 'pressure_close_direct'
  | 'multi_direct'
  | 'multi_with_detail';

export type VoicePerspective = 'assistant_action' | 'item_state' | 'question';
export type ToneStage = 'quiet' | 'light_check' | 'direct' | 'firm' | 'recovery';

export type UserSituation =
  | 'clear_and_decisive'
  | 'needs_clarity'
  | 'possibly_overloaded'
  | 'deferring'
  | 'avoiding'
  | 'recovering';

export type UserSituationReason =
  | 'answered_clarification'
  | 'missed_same_commitment'
  | 'repeated_postpone'
  | 'many_open_items'
  | 'recent_completion'
  | 'recent_no_response'
  | 'ambiguous_input';

export type UserSituationAnalysis = {
  situation: UserSituation;
  confidence: 'low' | 'medium' | 'high';
  reasonCodes: UserSituationReason[];
};

export type ResponsePlan = {
  intent: CommunicativeIntent;
  supportIntent?: CommunicativeIntent;
  strategy: ResponseStrategy;
  moves: RhetoricalMove[];
  facts: {
    title?: string;
    titleLower?: string;
    titleCapitalized?: string;
    titleKind?: 'action' | 'noun' | 'context';
    reminderObject?: string;
    reminderNoun?: string;
    contextClause?: string;
    timeText?: string;
    timeWithPreposition?: string;
    stateChange?: 'created' | 'completed' | 'moved' | 'cancelled' | 'updated' | 'acknowledged' | 'none';
    noChangeReason?: 'informational' | 'unsafe' | 'expired' | 'ambiguous';
    missing?: 'time' | 'action' | 'person' | 'unknown';
    continuityText?: string;
    scheduledTitles?: string[];
    reviewTitles?: string[];
    savedCount?: number;
    totalCount?: number;
    needsClarification?: number;
  };
  constraints: {
    tone: ToneStage;
    maxSentences: 1 | 2;
    requireQuestion: boolean;
    forbiddenTerms: string[];
  };
};

export type RealizationCandidate = {
  path: RealizationPath;
  moves: RhetoricalMove[];
  compatibleStrategies?: ResponseStrategy[];
  text: string;
  requiredFacts: Array<keyof ResponsePlan['facts']>;
  disallowedStates: Array<NonNullable<ResponsePlan['facts']['stateChange']>>;
  voicePerspective: VoicePerspective;
};

export type AssistantTurn = {
  message: string;
  plan: ResponsePlan;
  ui: {
    expectedUserAction: 'none' | 'clarify' | 'confirm' | 'choose';
    controls?: Array<'confirm' | 'reschedule' | 'complete' | 'drop'>;
  };
  debug?: {
    semanticEvent: SemanticEvent;
    situation: UserSituationAnalysis;
    validation: ReturnType<typeof validateResponsePlanAndMessage>;
    realizationPath?: RealizationPath;
  };
};

export type CreateAssistantTurnInput = {
  event: SemanticEvent;
  scopeId?: string;
  now?: Date;
  store?: ConversationStateStore;
  conversationState?: ConversationLevelState;
  commitmentState?: CommitmentConversationState;
  record?: boolean;
  realization?: RealizationOptions;
};

function expectedUserActionFor(plan: ResponsePlan): AssistantTurn['ui']['expectedUserAction'] {
  if (plan.intent === 'clarify_missing_detail') return 'clarify';
  if (plan.intent === 'request_confirmation') return 'confirm';
  if (plan.intent === 'nudge' || plan.intent === 'probe_blocker' || plan.intent === 'reset_plan' || plan.intent === 'escalate_choice') {
    return 'choose';
  }
  return 'none';
}

function isPressureEvent(event: SemanticEvent): event is Extract<SemanticEvent, { type: 'pressure_due' }> {
  return event.type === 'pressure_due';
}

export function createAssistantTurn(input: CreateAssistantTurnInput): AssistantTurn {
  const store = input.store || getConversationStateStore();
  const scopeId = input.scopeId || 'local';
  const conversationState = input.conversationState || store.get(scopeId);
  const commitmentState = input.commitmentState || (isPressureEvent(input.event)
    ? store.getCommitment(scopeId, input.event.commitmentId)
    : undefined);
  const situation = analyzeUserSituation({
    event: input.event,
    conversationState,
    commitmentState,
  });
  const planInput: BuildResponsePlanInput = {
    event: input.event,
    situation,
    conversationState,
    commitmentState,
    now: input.now,
  };
  const plan = buildResponsePlan(planInput);
  const realized = realizeResponsePlan(plan, {
    conversationState,
    commitmentState,
    entropy: input.realization?.entropy,
  });
  const validation = validateResponsePlanAndMessage(plan, realized.message);
  const message = validation.ok ? realized.message : realized.fallbackMessage;

  if (input.record !== false) {
    store.recordTurn(scopeId, {
      eventType: input.event.type,
      intent: plan.intent,
      strategy: plan.strategy,
      path: realized.path,
      move: plan.moves[0],
      commitmentId: isPressureEvent(input.event) ? input.event.commitmentId : undefined,
    });
  }

  return {
    message,
    plan,
    ui: { expectedUserAction: expectedUserActionFor(plan) },
    debug: {
      semanticEvent: input.event,
      situation,
      validation,
      realizationPath: realized.path,
    },
  };
}
