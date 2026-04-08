import type { ResponsePlan } from './assistantTurn';

export type ResponseValidationResult = {
  ok: boolean;
  errors: string[];
};

const LEGACY_AND_INTERNAL_PATTERNS = [
  /Tracking/i,
  /Drafted/i,
  /Executed/i,
  /You're set/i,
  /\bdisposition\b/i,
  /\bcommand\b/i,
  /\b20\d\d-\d\d-\d\d(?:T|\b)/,
  /\b20\d\d-\d\d-\d\d at \d\d:\d\d\b/i,
];

const SHAME_PATTERNS = [
  /\bavoidant\b/i,
  /\binconsistent\b/i,
  /\blazy\b/i,
  /\bfault\b/i,
  /\bfailed\b/i,
  /\bshame\b/i,
  /\bguilt\b/i,
  /\bdisappointed\b/i,
];

const CREATION_OR_TRACKING_CLAIM = /\b(saved?|saving|created?|creating|scheduled?|scheduling|reminder|remind|tracking?|tracked)\b/i;
const NO_CHANGE_CLAIM = /\b(didn'?t change|did not change|couldn'?t change|could not change|left (?:it |things )?unchanged|no changes?|nothing changed|wasn'?t changed|was not changed)\b/i;
const APPLIED_CHANGE_CLAIM = /\b(done|complete[sd]?|marked|saved|created|scheduled|cancelled|canceled|dropped|moved|updated|I moved|I saved|I'?ll remind)\b/i;
const COMPLETION_CLAIM = /\b(done|complete[sd]?|marked complete|off the list|closed)\b/i;

function sentenceCount(message: string): number {
  const matches = message.match(/[.?!](?:\s|$)/g);
  return matches ? matches.length : 1;
}

function lexicalValidationErrors(message: string): string[] {
  const errors: string[] = [];
  for (const pattern of LEGACY_AND_INTERNAL_PATTERNS) {
    if (pattern.test(message)) errors.push(`forbidden scaffold: ${pattern}`);
  }
  for (const pattern of SHAME_PATTERNS) {
    if (pattern.test(message)) errors.push(`forbidden shame label: ${pattern}`);
  }
  return errors;
}

function planConsistencyErrors(plan: ResponsePlan): string[] {
  const errors: string[] = [];
  if (plan.intent === 'confirm_result' && !plan.facts.stateChange) errors.push('confirm_result requires a state change');
  if (plan.intent === 'clarify_missing_detail' && plan.facts.stateChange && plan.facts.stateChange !== 'none') {
    errors.push('clarification cannot claim a state change');
  }
  if (plan.intent === 'acknowledge_no_change' && plan.facts.stateChange !== 'none') {
    errors.push('no-change acknowledgement requires stateChange none');
  }
  if (plan.intent === 'request_confirmation' && plan.facts.stateChange) {
    errors.push('confirmation request cannot claim an applied state change');
  }
  if (plan.intent === 'confirm_result' && plan.facts.stateChange === 'none') {
    errors.push('confirm_result cannot use stateChange none');
  }
  if (plan.facts.noChangeReason && plan.facts.stateChange && plan.facts.stateChange !== 'none') {
    errors.push('noChangeReason cannot be combined with an applied state change');
  }
  return errors;
}

function structuralValidationErrors(plan: ResponsePlan, message: string): string[] {
  const errors: string[] = [];
  if (plan.constraints.requireQuestion && !message.includes('?')) errors.push('question required');
  if (sentenceCount(message) > plan.constraints.maxSentences) errors.push('too many sentences');
  if (message.includes(';')) errors.push('semicolon in user-visible message');
  return errors;
}

function semanticValidationErrors(plan: ResponsePlan, message: string): string[] {
  const errors: string[] = [];
  if (plan.intent === 'clarify_missing_detail' && plan.facts.missing === 'time' && !/\b(when|what time|date)\b/i.test(message)) {
    errors.push('time clarification must ask about time');
  }
  if (plan.intent === 'clarify_missing_detail' && plan.facts.missing === 'action' && !/\b(what|reminder say|bring back)\b/i.test(message)) {
    errors.push('action clarification must ask about action');
  }
  if (plan.intent === 'clarify_missing_detail' && plan.facts.missing === 'person' && !/\bwho\b/i.test(message)) {
    errors.push('person clarification must ask who');
  }
  if (plan.facts.stateChange === 'created' && plan.facts.timeText && !message.includes(plan.facts.timeText)) {
    errors.push('created reminder with known time must include time');
  }
  if (plan.facts.stateChange === 'completed' && CREATION_OR_TRACKING_CLAIM.test(message)) {
    errors.push('completion resembles creation or tracking');
  }
  if (plan.facts.stateChange === 'completed' && NO_CHANGE_CLAIM.test(message)) {
    errors.push('completion cannot claim no change');
  }
  if (plan.facts.stateChange && plan.facts.stateChange !== 'none' && NO_CHANGE_CLAIM.test(message)) {
    errors.push('applied state change cannot use no-change language');
  }
  if (plan.facts.stateChange === 'none' && /\b(saved|created|scheduled|done)\b/i.test(message)) {
    errors.push('no-change message implies persistence');
  }
  if (plan.facts.stateChange === 'none' && COMPLETION_CLAIM.test(message)) {
    errors.push('no-change message implies completion');
  }
  if (plan.intent === 'request_confirmation' && /\b(done|complete|completed|moved|cancelled)\b/i.test(message)) {
    errors.push('confirmation request claims a completed action');
  }
  if ((plan.intent === 'nudge' || plan.intent === 'probe_blocker' || plan.intent === 'reset_plan' || plan.intent === 'escalate_choice') &&
    APPLIED_CHANGE_CLAIM.test(message)) {
    errors.push('pressure claims a state change');
  }
  if ((plan.intent === 'nudge' || plan.intent === 'probe_blocker' || plan.intent === 'reset_plan' || plan.intent === 'escalate_choice') &&
    plan.facts.stateChange && plan.facts.stateChange !== 'none') {
    errors.push('pressure plan cannot carry an applied state change');
  }
  return errors;
}

function strategyAlignmentErrors(plan: ResponsePlan, message: string): string[] {
  const errors: string[] = [];
  if (!plan.moves.includes('name_continuity')) return errors;

  const easyChoice = /\b(keep it for today|move it\?|do it|handle it today)\b/i.test(message);
  const blocker = /\b(blocking|blocker|stuck|what's blocking|what is blocking)\b/i.test(message);
  const smallerStep = /\b(smaller next step|manageable step|make it smaller|next manageable step)\b/i.test(message);
  const reset = /\b(reset|replan|plan)\b/i.test(message);
  const closeLoop = /\b(finish it|drop it|still open)\b/i.test(message);

  if (plan.strategy === 'easy_choice') {
    if (!easyChoice) errors.push('easy_choice pressure must offer a simple keep/move or do/move choice');
    if (blocker || reset || closeLoop) errors.push('easy_choice pressure realized an incompatible pressure move');
  }
  if (plan.strategy === 'blocker_probe') {
    if (!blocker) errors.push('blocker_probe pressure must ask about a blocker');
    if (easyChoice) errors.push('blocker_probe pressure realized easy-choice language');
  }
  if (plan.strategy === 'smaller_step') {
    if (!smallerStep) errors.push('smaller_step pressure must ask for or offer a smaller step');
    if (blocker || easyChoice || reset || closeLoop) errors.push('smaller_step pressure realized an incompatible pressure move');
  }
  if (plan.strategy === 'reset_plan') {
    if (!reset) errors.push('reset_plan pressure must include reset or replan language');
    if (blocker || easyChoice || closeLoop) errors.push('reset_plan pressure realized an incompatible pressure move');
  }
  if (plan.strategy === 'close_loop') {
    if (!closeLoop) errors.push('close_loop pressure must use closure language');
    if (blocker || easyChoice || smallerStep || reset) errors.push('close_loop pressure realized an incompatible pressure move');
  }

  return errors;
}

export function validateResponsePlanAndMessage(plan: ResponsePlan, message: string): ResponseValidationResult {
  const errors = [
    ...planConsistencyErrors(plan),
    ...lexicalValidationErrors(message),
    ...structuralValidationErrors(plan, message),
    ...semanticValidationErrors(plan, message),
    ...strategyAlignmentErrors(plan, message),
  ];
  return { ok: errors.length === 0, errors };
}
