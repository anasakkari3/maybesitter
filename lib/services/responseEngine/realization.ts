import type { RealizationCandidate, RealizationPath, ResponsePlan, ResponseStrategy, RhetoricalMove, ToneStage } from './assistantTurn';
import type { CommitmentConversationState, ConversationLevelState } from './conversationStateStore';
import { validateResponsePlanAndMessage } from './validation';

export type RealizationOptions = {
  entropy?: () => number;
};

export type RealizationResult = {
  message: string;
  fallbackMessage: string;
  path: RealizationPath;
};

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

function reminderObject(title: string | undefined): string {
  if (!title) return 'that';
  return /^(call|text|email|message|follow up|send|pay|book|schedule|submit|finish|review|check|pick up|buy|renew|reply|read)\b/i.test(title)
    ? `to ${lowerFirst(title)}`
    : `about ${lowerFirst(title)}`;
}

function normalizedTitleLower(plan: ResponsePlan): string | undefined {
  return plan.facts.titleLower || (plan.facts.title ? lowerFirst(plan.facts.title) : undefined);
}

function normalizedTitleCap(plan: ResponsePlan): string | undefined {
  return plan.facts.titleCapitalized || (plan.facts.title ? capitalFirst(plan.facts.title) : undefined);
}

function reminderObjectFor(plan: ResponsePlan): string {
  return plan.facts.reminderObject || reminderObject(plan.facts.title);
}

function timeWithPreposition(plan: ResponsePlan): string | undefined {
  return plan.facts.timeWithPreposition || plan.facts.timeText;
}

function listText(values: readonly string[] | undefined): string {
  const items = (values || []).map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function candidate(
  plan: ResponsePlan,
  path: RealizationPath,
  moves: RhetoricalMove[],
  text: string | null | undefined,
  voicePerspective: RealizationCandidate['voicePerspective'],
  requiredFacts: Array<keyof ResponsePlan['facts']> = [],
  disallowedStates: RealizationCandidate['disallowedStates'] = [],
  compatibleStrategies?: ResponseStrategy[]
): RealizationCandidate[] {
  const cleaned = clean(text || undefined);
  if (!cleaned) return [];
  if (requiredFacts.some((fact) => plan.facts[fact] === undefined)) return [];
  if (plan.facts.stateChange && disallowedStates.includes(plan.facts.stateChange)) return [];
  return [{ path, moves, compatibleStrategies, text: cleaned, requiredFacts, disallowedStates, voicePerspective }];
}

type NonPressureClauses = {
  title?: string;
  titleLower?: string;
  titleCap?: string;
  reminderObject: string;
  reminderNoun: string;
  time?: string;
  timePrep?: string;
  context?: string;
};

function nonPressureClauses(plan: ResponsePlan): NonPressureClauses {
  const title = clean(plan.facts.title);
  const titleLower = normalizedTitleLower(plan);
  const titleCap = normalizedTitleCap(plan);
  const reminderObjectText = reminderObjectFor(plan);
  const reminderNoun = title
    ? plan.facts.titleKind === 'action'
      ? `reminder ${reminderObjectText}`
      : plan.facts.reminderNoun || `reminder about ${titleLower}`
    : 'reminder';
  return {
    title,
    titleLower,
    titleCap,
    reminderObject: reminderObjectText,
    reminderNoun,
    time: plan.facts.timeText,
    timePrep: timeWithPreposition(plan),
    context: plan.facts.contextClause || title,
  };
}

function sentence(clause: string | null | undefined): string | null {
  const text = clean(clause || undefined);
  if (!text) return null;
  return /[.?!]$/.test(text) ? text : `${text}.`;
}

function question(clause: string | null | undefined): string | null {
  const text = clean(clause || undefined);
  if (!text) return null;
  return text.endsWith('?') ? text : `${text}?`;
}

function done(clause: string | null | undefined): string | null {
  const text = clean(clause || undefined);
  if (!text) return null;
  const body = text.replace(/[.?!]$/, '');
  const readable = /^I(?:\b|')/.test(body) ? body : lowerFirst(body);
  return `Done, ${readable}.`;
}

function assistantReminderClause(clauses: NonPressureClauses, options: { includeObject?: boolean; includeTime?: boolean } = {}): string {
  const includeObject = options.includeObject !== false && clauses.title;
  const parts = ['I\'ll remind you'];
  if (includeObject) parts.push(clauses.reminderObject);
  if (options.includeTime && clauses.time) parts.push(clauses.time);
  return parts.join(' ');
}

function assistantActionClause(action: 'moved' | 'updated' | 'cancelled' | 'closed', clauses: NonPressureClauses, options: { timePreposition?: 'to' | 'for' } = {}): string {
  const object = clauses.titleLower || 'it';
  if (action === 'cancelled') return `I cancelled ${object}`;
  if (action === 'closed') return `I closed ${object}`;
  const timeTail = clauses.time ? ` ${options.timePreposition || 'to'} ${clauses.time}` : '';
  return `I ${action} ${object}${timeTail}`;
}

function itemStateClause(clauses: NonPressureClauses, state: 'complete' | 'cancelled' | 'active' | 'on_reminder_list' | 'set' | 'updated'): string | null {
  const subject = clauses.titleCap || 'That';
  if (state === 'complete') return `${subject} is complete`;
  if (state === 'cancelled') return `${subject} is cancelled`;
  if (state === 'active') return `${subject} stays active`;
  if (state === 'on_reminder_list') return clauses.time ? `${subject} is on your reminder list for ${clauses.time}` : `${subject} is on your reminder list`;
  if (state === 'set') return clauses.time ? `${subject} is now set for ${clauses.time}` : `${subject} is set`;
  if (state === 'updated') return clauses.time ? `${subject} is now for ${clauses.time}` : `${subject} is updated`;
  return null;
}

function reminderReadyClause(clauses: NonPressureClauses): string | null {
  if (!clauses.title || !clauses.timePrep) return null;
  return `I have a ${clauses.reminderNoun} ${clauses.timePrep}`;
}

function clarificationQuestionClause(plan: ResponsePlan, clauses: NonPressureClauses, path: RealizationPath): string | null {
  if (plan.facts.missing === 'action') {
    if (path === 'known_time_question') return clauses.time ? `I have ${clauses.time}. What should I remind you to do` : null;
    if (path === 'context_question') return clauses.time ? `What do you want me to bring back ${clauses.time}` : null;
    if (path === 'specific_missing_question') return 'What should the reminder say';
    return 'What should I remind you to do';
  }
  if (plan.facts.missing === 'person') {
    if (path === 'careful_confirmation') return 'Who should this follow-up be with';
    if (path === 'specific_missing_question') return 'Who is the follow-up for';
    if (path === 'context_question') return clauses.titleLower ? `Who should I use for ${clauses.titleLower}` : null;
    return 'Who should I attach this to';
  }
  if (path === 'context_question') return clauses.title ? `What time should I use ${clauses.reminderObject}` : null;
  if (path === 'known_time_question') return clauses.time ? `I have ${clauses.time}. What should I remind you to do` : null;
  if (path === 'specific_missing_question') return 'What should the reminder say';
  if (path === 'careful_confirmation') return 'Who should this follow-up be with';
  return clauses.title ? `When should I remind you ${clauses.reminderObject}` : 'When should I remind you';
}

function confirmationQuestionClause(clauses: NonPressureClauses, path: RealizationPath): string | null {
  const target = clauses.titleLower;
  if (path === 'proposed_change_question') return target ? `I can save a ${clauses.reminderNoun} as a reminder. Want me to` : 'I can save that as a reminder. Want me to';
  if (path === 'context_question') return target ? `Do you want a ${clauses.reminderNoun} on your reminder list` : 'Do you want this on your reminder list';
  if (path === 'direct_question') return target ? `Save a ${clauses.reminderNoun}` : 'Save this as a reminder';
  return target ? `Should I save a ${clauses.reminderNoun}` : 'Should I save that as a reminder';
}

function noChangeClause(plan: ResponsePlan, clauses: NonPressureClauses, path: RealizationPath): string {
  if (plan.facts.noChangeReason === 'unsafe') {
    if (path === 'boundary_ack') return "I didn't make changes because that wasn't safe to apply";
    if (path === 'context_boundary') return "I couldn't apply that safely, so I left things unchanged";
    if (path === 'assistant_commitment') return "I left things unchanged because that wasn't safe to apply";
    return "I couldn't change anything safely";
  }
  if (plan.facts.noChangeReason === 'expired') {
    if (path === 'boundary_ack') return "That clarification expired. Send the full request again and I'll use it";
    if (path === 'context_boundary') return "I couldn't find that clarification anymore, so I left things unchanged";
    if (path === 'assistant_commitment') return "I didn't change anything because that clarification expired";
    return "That expired, so I didn't change anything";
  }
  if (path === 'boundary_ack') return clauses.context ? `Got it, I won't turn "${clauses.context}" into a reminder` : "Got it, I won't turn that into a reminder";
  if (path === 'context_boundary') return clauses.context ? `I'll treat "${clauses.context}" as context, not a task` : "I'll treat that as context, not a task";
  if (path === 'assistant_commitment') return clauses.context ? `Understood, I won't add a reminder for "${clauses.context}"` : 'Understood, no reminder added';
  return "I didn't change anything";
}

function confirmActionCandidates(plan: ResponsePlan): RealizationCandidate[] {
  const clauses = nonPressureClauses(plan);

  switch (plan.facts.stateChange) {
    case 'created':
      return [
        ...candidate(plan, 'assistant_commitment', ['confirm_action'], sentence(assistantReminderClause(clauses, { includeTime: true })), 'assistant_action', clauses.time ? ['timeText'] : []),
        ...candidate(plan, 'task_set_for_time', ['confirm_action'], sentence(itemStateClause(clauses, 'on_reminder_list')), 'item_state', ['title', 'timeText']),
        ...candidate(plan, 'done_assistant_commitment', ['confirm_action'], clauses.time ? done(assistantReminderClause(clauses, { includeObject: false, includeTime: true })) : done(assistantReminderClause(clauses)), 'assistant_action'),
        ...candidate(plan, 'time_first_commitment', ['confirm_action'], clauses.title && clauses.time ? sentence(`${capitalFirst(clauses.time)} is when ${lowerFirst(assistantReminderClause(clauses))}`) : null, 'assistant_action', ['title', 'timeText']),
        ...candidate(plan, 'reminder_ready', ['confirm_action'], sentence(reminderReadyClause(clauses)), 'assistant_action', ['title', 'timeText']),
      ];
    case 'moved':
      return [
        ...candidate(plan, 'moved_by_assistant', ['confirm_action'], sentence(assistantActionClause('moved', clauses, { timePreposition: 'to' })), 'assistant_action'),
        ...candidate(plan, 'assistant_commitment', ['confirm_action'], sentence(itemStateClause(clauses, 'set')), 'item_state', ['title', 'timeText']),
        ...candidate(plan, 'done_assistant_commitment', ['confirm_action'], done(assistantActionClause('moved', { ...clauses, titleLower: 'it' }, { timePreposition: 'to' })), 'assistant_action'),
        ...candidate(plan, 'task_set_for_time', ['confirm_action'], clauses.title && clauses.time ? sentence(`The ${clauses.titleLower} reminder is now for ${clauses.time}`) : null, 'item_state', ['title', 'timeText']),
      ];
    case 'updated':
      return [
        ...candidate(plan, 'moved_by_assistant', ['confirm_action'], sentence(assistantActionClause('updated', clauses, { timePreposition: 'for' })), 'assistant_action'),
        ...candidate(plan, 'task_set_for_time', ['confirm_action'], sentence(itemStateClause(clauses, 'updated')), 'item_state', ['title', 'timeText']),
        ...candidate(plan, 'done_assistant_commitment', ['confirm_action'], done(assistantActionClause('updated', { ...clauses, titleLower: 'it' }, { timePreposition: 'for' })), 'assistant_action'),
        ...candidate(plan, 'reminder_ready', ['confirm_action'], clauses.title && clauses.time ? sentence(`I have ${clauses.titleLower} set for ${clauses.time} now`) : null, 'assistant_action', ['title', 'timeText']),
      ];
    case 'cancelled':
      return [
        ...candidate(plan, 'cancelled_by_assistant', ['confirm_action'], sentence(assistantActionClause('cancelled', clauses)), 'assistant_action'),
        ...candidate(plan, 'item_state_closure', ['confirm_action'], sentence(itemStateClause(clauses, 'cancelled')), 'item_state'),
        ...candidate(plan, 'done_state', ['confirm_action'], done(itemStateClause(clauses, 'cancelled')), 'item_state'),
        ...candidate(plan, 'assistant_closed', ['confirm_action'], sentence(`I took ${clauses.titleLower || 'it'} off the active list`), 'assistant_action'),
      ];
    case 'acknowledged':
      return [
        ...candidate(plan, 'assistant_closed', ['confirm_action'], sentence(`Got it, I'll leave ${clauses.titleLower || 'it'} active`), 'assistant_action'),
        ...candidate(plan, 'item_state_closure', ['confirm_action'], sentence(clauses.titleCap ? `${clauses.titleCap} stays on your list` : 'That stays on your list'), 'item_state'),
        ...candidate(plan, 'done_state', ['confirm_action'], sentence(`Okay, ${clauses.titleLower || 'that'} stays active`), 'item_state'),
        ...candidate(plan, 'assistant_commitment', ['confirm_action'], sentence(`I'll keep ${clauses.titleLower || 'it'} in view`), 'assistant_action'),
      ];
    default:
      return [];
  }
}

function closeLoopCandidates(plan: ResponsePlan): RealizationCandidate[] {
  const clauses = nonPressureClauses(plan);
  return [
    ...candidate(plan, 'done_state', ['close_loop'], done(itemStateClause(clauses, 'complete')), 'item_state'),
    ...candidate(plan, 'item_state_closure', ['close_loop'], sentence(itemStateClause(clauses, 'complete')), 'item_state'),
    ...candidate(plan, 'assistant_closed', ['close_loop'], sentence(assistantActionClause('closed', clauses)), 'assistant_action'),
    ...candidate(plan, 'direct_question', ['close_loop'], sentence(`Good, ${clauses.titleLower || 'that'} is off the list`), 'item_state'),
  ];
}

function clarificationCandidates(plan: ResponsePlan): RealizationCandidate[] {
  const clauses = nonPressureClauses(plan);
  if (plan.facts.missing === 'action') {
    return [
      ...candidate(plan, 'known_time_question', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'known_time_question')), 'question', ['timeText']),
      ...candidate(plan, 'specific_missing_question', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'specific_missing_question')), 'question'),
      ...candidate(plan, 'direct_question', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'direct_question')), 'question'),
      ...candidate(plan, 'context_question', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'context_question')), 'question', ['timeText']),
    ];
  }
  if (plan.facts.missing === 'person') {
    return [
      ...candidate(plan, 'careful_confirmation', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'careful_confirmation')), 'question'),
      ...candidate(plan, 'specific_missing_question', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'specific_missing_question')), 'question'),
      ...candidate(plan, 'direct_question', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'direct_question')), 'question'),
      ...candidate(plan, 'context_question', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'context_question')), 'question', ['title']),
    ];
  }
  return [
    ...candidate(plan, 'direct_question', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'direct_question')), 'question'),
    ...candidate(plan, 'context_question', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'context_question')), 'question', ['title']),
    ...candidate(plan, 'known_time_question', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'known_time_question')), 'question', ['timeText']),
    ...candidate(plan, 'specific_missing_question', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'specific_missing_question')), 'question'),
    ...candidate(plan, 'careful_confirmation', ['ask_missing_detail'], question(clarificationQuestionClause(plan, clauses, 'careful_confirmation')), 'question'),
  ];
}

function confirmationCandidates(plan: ResponsePlan): RealizationCandidate[] {
  const clauses = nonPressureClauses(plan);
  return [
    ...candidate(plan, 'careful_confirmation', ['ask_confirmation'], question(confirmationQuestionClause(clauses, 'careful_confirmation')), 'question'),
    ...candidate(plan, 'proposed_change_question', ['ask_confirmation'], question(confirmationQuestionClause(clauses, 'proposed_change_question')), 'question'),
    ...candidate(plan, 'context_question', ['ask_confirmation'], question(confirmationQuestionClause(clauses, 'context_question')), 'question'),
    ...candidate(plan, 'direct_question', ['ask_confirmation'], question(confirmationQuestionClause(clauses, 'direct_question')), 'question'),
  ];
}

function noChangeCandidates(plan: ResponsePlan): RealizationCandidate[] {
  const clauses = nonPressureClauses(plan);
  if (plan.facts.noChangeReason === 'unsafe') {
    return [
      ...candidate(plan, 'plain_no_change', ['acknowledge_without_action'], sentence(noChangeClause(plan, clauses, 'plain_no_change')), 'assistant_action'),
      ...candidate(plan, 'boundary_ack', ['acknowledge_without_action'], sentence(noChangeClause(plan, clauses, 'boundary_ack')), 'assistant_action'),
      ...candidate(plan, 'context_boundary', ['acknowledge_without_action'], sentence(noChangeClause(plan, clauses, 'context_boundary')), 'assistant_action'),
      ...candidate(plan, 'assistant_commitment', ['acknowledge_without_action'], sentence(noChangeClause(plan, clauses, 'assistant_commitment')), 'assistant_action'),
    ];
  }
  if (plan.facts.noChangeReason === 'expired') {
    return [
      ...candidate(plan, 'plain_no_change', ['acknowledge_without_action'], sentence(noChangeClause(plan, clauses, 'plain_no_change')), 'assistant_action'),
      ...candidate(plan, 'boundary_ack', ['acknowledge_without_action'], sentence(noChangeClause(plan, clauses, 'boundary_ack')), 'assistant_action'),
      ...candidate(plan, 'context_boundary', ['acknowledge_without_action'], sentence(noChangeClause(plan, clauses, 'context_boundary')), 'assistant_action'),
      ...candidate(plan, 'assistant_commitment', ['acknowledge_without_action'], sentence(noChangeClause(plan, clauses, 'assistant_commitment')), 'assistant_action'),
    ];
  }
  return [
    ...candidate(plan, 'boundary_ack', ['acknowledge_without_action'], sentence(noChangeClause(plan, clauses, 'boundary_ack')), 'assistant_action'),
    ...candidate(plan, 'context_boundary', ['acknowledge_without_action'], sentence(noChangeClause(plan, clauses, 'context_boundary')), 'assistant_action'),
    ...candidate(plan, 'plain_no_change', ['acknowledge_without_action'], sentence(noChangeClause(plan, clauses, 'plain_no_change')), 'assistant_action'),
    ...candidate(plan, 'assistant_commitment', ['acknowledge_without_action'], sentence(noChangeClause(plan, clauses, 'assistant_commitment')), 'assistant_action'),
  ];
}

type PressureOpenerType = 'continuity_first' | 'time_first' | 'blocker_first' | 'decision_first' | 'reset_first' | 'direct_question';
type PressureMoveType = 'easy_choice' | 'smaller_step' | 'blocker_probe' | 'reset_plan' | 'close_loop';

type PressureComposition = {
  path: RealizationPath;
  opener: PressureOpenerType;
  move: PressureMoveType;
  strategy: ResponseStrategy;
  styles: ToneStage[];
  moves: RhetoricalMove[];
  voicePerspective: RealizationCandidate['voicePerspective'];
};

type PressureParts = {
  continuity: string;
  item: string;
  itemCap: string;
};

const PRESSURE_COMPOSITIONS: PressureComposition[] = [
  { path: 'continuity_choice', opener: 'continuity_first', move: 'easy_choice', strategy: 'easy_choice', styles: ['light_check', 'direct'], moves: ['name_continuity', 'offer_small_step'], voicePerspective: 'question' },
  { path: 'pressure_decision_choice', opener: 'decision_first', move: 'easy_choice', strategy: 'easy_choice', styles: ['light_check', 'direct'], moves: ['name_continuity', 'offer_small_step'], voicePerspective: 'question' },
  { path: 'pressure_time_choice', opener: 'time_first', move: 'easy_choice', strategy: 'easy_choice', styles: ['light_check', 'direct'], moves: ['name_continuity', 'offer_small_step'], voicePerspective: 'question' },
  { path: 'continuity_small_step', opener: 'continuity_first', move: 'smaller_step', strategy: 'smaller_step', styles: ['direct', 'firm'], moves: ['name_continuity', 'offer_small_step'], voicePerspective: 'assistant_action' },
  { path: 'pressure_direct_small_step', opener: 'decision_first', move: 'smaller_step', strategy: 'smaller_step', styles: ['direct', 'firm'], moves: ['name_continuity', 'offer_small_step'], voicePerspective: 'assistant_action' },
  { path: 'time_first_commitment', opener: 'direct_question', move: 'smaller_step', strategy: 'smaller_step', styles: ['direct', 'firm'], moves: ['name_continuity', 'offer_small_step'], voicePerspective: 'question' },
  { path: 'continuity_blocker', opener: 'continuity_first', move: 'blocker_probe', strategy: 'blocker_probe', styles: ['direct', 'firm'], moves: ['name_continuity', 'probe_blocker'], voicePerspective: 'question' },
  { path: 'pressure_blocker_first', opener: 'blocker_first', move: 'blocker_probe', strategy: 'blocker_probe', styles: ['direct', 'firm'], moves: ['name_continuity', 'probe_blocker'], voicePerspective: 'question' },
  { path: 'direct_question', opener: 'direct_question', move: 'blocker_probe', strategy: 'blocker_probe', styles: ['direct', 'firm'], moves: ['name_continuity', 'probe_blocker'], voicePerspective: 'question' },
  { path: 'continuity_reset', opener: 'continuity_first', move: 'reset_plan', strategy: 'reset_plan', styles: ['direct', 'firm'], moves: ['name_continuity', 'offer_reset'], voicePerspective: 'assistant_action' },
  { path: 'pressure_reset_first', opener: 'reset_first', move: 'reset_plan', strategy: 'reset_plan', styles: ['direct', 'firm'], moves: ['name_continuity', 'offer_reset'], voicePerspective: 'assistant_action' },
  { path: 'pressure_decision_reset', opener: 'decision_first', move: 'reset_plan', strategy: 'reset_plan', styles: ['direct', 'firm'], moves: ['name_continuity', 'offer_reset'], voicePerspective: 'assistant_action' },
  { path: 'decision_close', opener: 'decision_first', move: 'close_loop', strategy: 'close_loop', styles: ['firm'], moves: ['name_continuity', 'force_choice'], voicePerspective: 'assistant_action' },
  { path: 'pressure_close_direct', opener: 'direct_question', move: 'close_loop', strategy: 'close_loop', styles: ['firm'], moves: ['name_continuity', 'force_choice'], voicePerspective: 'assistant_action' },
];

function pressureParts(plan: ResponsePlan): PressureParts {
  const title = clean(plan.facts.title) || 'it';
  const item = normalizedTitleLower(plan) || lowerFirst(title);
  return {
    continuity: clean(plan.facts.continuityText) || clean(plan.facts.title) || 'This is still open',
    item,
    itemCap: capitalFirst(item),
  };
}

function pressureOpenerText(opener: PressureOpenerType, parts: PressureParts): string | null {
  if (opener === 'continuity_first') return parts.continuity;
  if (opener === 'time_first') return `For ${parts.item}`;
  if (opener === 'blocker_first') return `${parts.itemCap} looks stuck`;
  if (opener === 'decision_first') return `Decide on ${parts.item}`;
  if (opener === 'reset_first') return `The plan for ${parts.item} is not sticking`;
  return null;
}

function pressureMoveText(move: PressureMoveType, opener: PressureOpenerType, parts: PressureParts): string {
  if (move === 'easy_choice') return opener === 'decision_first' ? 'do it today or move it?' : 'Keep it for today or move it?';
  if (move === 'smaller_step') {
    if (opener === 'direct_question') return `What is the next manageable step for ${parts.item}?`;
    return opener === 'decision_first' ? 'pick a smaller next step or move it.' : 'Pick a smaller next step or move it.';
  }
  if (move === 'blocker_probe') return opener === 'direct_question' ? `What's blocking ${parts.item}?` : "What's blocking it?";
  if (move === 'reset_plan') return opener === 'decision_first' ? 'reset the plan or make it smaller.' : 'Reset the plan or make it smaller.';
  return opener === 'decision_first' ? 'finish it, move it, or drop it.' : `${parts.itemCap} is still open. Finish it, move it, or drop it.`;
}

function composePressureText(composition: PressureComposition, parts: PressureParts): string {
  const opener = pressureOpenerText(composition.opener, parts);
  const move = pressureMoveText(composition.move, composition.opener, parts);
  if (!opener) return capitalFirst(move);
  if (composition.opener === 'time_first') return `${opener}, ${lowerFirst(move)}`;
  if (composition.opener === 'decision_first') return `${opener}: ${lowerFirst(move)}`;
  return `${opener}. ${capitalFirst(move)}`;
}

function pressureCandidates(plan: ResponsePlan): RealizationCandidate[] {
  const parts = pressureParts(plan);
  const all = PRESSURE_COMPOSITIONS
    .filter((composition) => composition.styles.includes(plan.constraints.tone))
    .flatMap((composition) => candidate(
      plan,
      composition.path,
      composition.moves,
      composePressureText(composition, parts),
      composition.voicePerspective,
      [],
      [],
      [composition.strategy]
    ));
  return all.filter((item) => isCandidateCompatibleWithPlan(item, plan));
}

function multiCandidates(plan: ResponsePlan): RealizationCandidate[] {
  const savedCount = plan.facts.savedCount || 0;
  const scheduled = listText(plan.facts.scheduledTitles);
  const review = listText(plan.facts.reviewTitles);
  const needs = plan.facts.needsClarification || 0;
  const lead = savedCount === 1 ? 'I saved one item' : `I saved ${savedCount} items`;
  const detail = [scheduled ? `scheduled ${scheduled}` : '', review ? `kept ${review} for review` : ''].filter(Boolean).join(' and ');
  return [
    ...candidate(plan, 'multi_direct', ['summarize_multiple'], detail ? `${lead}: ${detail}.` : `${lead}.`, 'assistant_action'),
    ...candidate(plan, 'multi_with_detail', ['summarize_multiple'], detail ? `${lead}. I ${detail}.` : `${lead}.`, 'assistant_action'),
    ...candidate(plan, 'assistant_commitment', ['summarize_multiple'], needs > 0 ? `${lead}, and ${needs === 1 ? 'one item needs' : `${needs} items need`} more detail.` : null, 'assistant_action'),
    ...candidate(plan, 'item_state_closure', ['summarize_multiple'], savedCount > 0 ? `${savedCount === 1 ? 'One item is' : `${savedCount} items are`} saved.` : null, 'item_state'),
  ];
}

function candidatesFor(plan: ResponsePlan): RealizationCandidate[] {
  if (plan.moves.includes('confirm_action')) return confirmActionCandidates(plan);
  if (plan.moves.includes('close_loop')) return closeLoopCandidates(plan);
  if (plan.moves.includes('ask_missing_detail')) return clarificationCandidates(plan);
  if (plan.moves.includes('ask_confirmation')) return confirmationCandidates(plan);
  if (plan.moves.includes('acknowledge_without_action')) return noChangeCandidates(plan);
  if (plan.moves.includes('summarize_multiple')) return multiCandidates(plan);
  if (plan.moves.includes('name_continuity')) return pressureCandidates(plan);
  return [];
}

function isCandidateCompatibleWithPlan(candidate: RealizationCandidate, plan: ResponsePlan): boolean {
  if (candidate.moves.some((move) => !plan.moves.includes(move))) return false;
  if (candidate.compatibleStrategies && !candidate.compatibleStrategies.includes(plan.strategy)) return false;
  return true;
}

function scoreCandidate(candidate: RealizationCandidate, plan: ResponsePlan, conversationState: ConversationLevelState, commitmentState?: CommitmentConversationState): number {
  let score = candidate.voicePerspective === 'assistant_action' ? 1.2 : 1;
  if (plan.intent === 'close_loop' && candidate.voicePerspective === 'item_state') score += 0.3;
  if (commitmentState?.lastPath === candidate.path) score -= 1.4;
  if (conversationState.lastPathsByIntent[plan.intent] === candidate.path) score -= 0.9;
  score -= (conversationState.pathCounts[candidate.path] || 0) * 0.18;
  if (conversationState.recentPaths.includes(candidate.path)) score -= 0.4;
  if (conversationState.recentPaths[conversationState.recentPaths.length - 1] === candidate.path) score -= 2;
  return score;
}

function chooseCandidate(candidates: RealizationCandidate[], plan: ResponsePlan, conversationState: ConversationLevelState, commitmentState: CommitmentConversationState | undefined, entropy: () => number): RealizationCandidate | null {
  const valid = candidates.filter((item) => isCandidateCompatibleWithPlan(item, plan) && validateResponsePlanAndMessage(plan, item.text).ok);
  if (valid.length === 0) return null;
  const lastPath = conversationState.recentPaths[conversationState.recentPaths.length - 1];
  const noImmediateRepeat = valid.filter((item) => item.path !== lastPath && item.path !== commitmentState?.lastPath);
  const pool = noImmediateRepeat.length > 0 ? noImmediateRepeat : valid;
  const ranked = pool
    .map((item) => ({ item, score: scoreCandidate(item, plan, conversationState, commitmentState) }))
    .sort((a, b) => b.score - a.score);
  const bestScore = ranked[0]?.score ?? 0;
  const close = ranked.filter((item) => bestScore - item.score <= 0.45);
  const index = Math.min(close.length - 1, Math.floor(entropy() * close.length));
  return close[index]?.item || ranked[0]?.item || null;
}

export function safeFallback(plan: ResponsePlan): string {
  if (plan.intent === 'clarify_missing_detail') return 'What detail should I use?';
  if (plan.intent === 'request_confirmation') return 'Should I save that as a reminder?';
  if (plan.facts.stateChange === 'completed') return 'Done, that is complete.';
  if (plan.facts.stateChange === 'moved') return plan.facts.timeText ? `I moved it to ${plan.facts.timeText}.` : 'I moved it.';
  if (plan.facts.stateChange === 'cancelled') return 'I cancelled it.';
  if (plan.facts.stateChange === 'created') return plan.facts.timeText ? `I'll remind you ${plan.facts.timeText}.` : "I'll remind you.";
  if (plan.facts.noChangeReason) return "I didn't change anything.";
  return "I couldn't do that safely.";
}

export function realizeResponsePlan(plan: ResponsePlan, input: {
  conversationState: ConversationLevelState;
  commitmentState?: CommitmentConversationState;
  entropy?: () => number;
}): RealizationResult {
  const fallbackMessage = safeFallback(plan);
  const fallbackPath: RealizationPath = plan.intent === 'clarify_missing_detail' ? 'direct_question' : 'assistant_commitment';
  const chosen = chooseCandidate(candidatesFor(plan), plan, input.conversationState, input.commitmentState, input.entropy || Math.random);
  if (!chosen) return { message: fallbackMessage, fallbackMessage, path: fallbackPath };
  return { message: chosen.text, fallbackMessage, path: chosen.path };
}
