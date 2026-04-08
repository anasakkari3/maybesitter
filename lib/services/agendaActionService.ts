import {
  applyCommand,
  getCommandServiceState,
  type CommandServiceResult,
} from './commandService';
import {
  recordBehaviorFeedback,
  type BehaviorFeedbackScopeOptions,
  type BehaviorFeedbackStore,
} from './behaviorFeedbackService';
import type { Command, Commitment } from '../../src/domain/stateMachine';

export type AgendaActionType = 'done' | 'aware' | 'postpone' | 'skip';

export interface AgendaActionResult {
  success: boolean;
  message: string;
}

export interface AgendaActionOptions extends BehaviorFeedbackScopeOptions {
  feedbackStore?: BehaviorFeedbackStore;
}

function isAgendaActionType(action: unknown): action is AgendaActionType {
  return action === 'done' || action === 'aware' || action === 'postpone' || action === 'skip';
}

function isDraftLike(commitment: Commitment): boolean {
  return commitment.status === 'draft' ||
    commitment.status === 'needs_clarification' ||
    commitment.status === 'pending_confirmation';
}

function tomorrowFrom(now: Date): string {
  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

function confirmCommand(commitment: Commitment, now: string): Command {
  return {
    type: 'ConfirmCommitment',
    commitmentId: commitment.id,
    now,
    reminders: [],
  };
}

function commandsForAction(commitment: Commitment, action: AgendaActionType, now: Date): Command[] {
  const nowIso = now.toISOString();

  switch (action) {
    case 'done':
      return isDraftLike(commitment)
        ? [confirmCommand(commitment, nowIso), { type: 'Complete', commitmentId: commitment.id, now: nowIso }]
        : [{ type: 'Complete', commitmentId: commitment.id, now: nowIso }];
    case 'aware':
      return isDraftLike(commitment)
        ? [confirmCommand(commitment, nowIso)]
        : [{ type: 'MarkAware', commitmentId: commitment.id, now: nowIso }];
    case 'postpone':
      return isDraftLike(commitment)
        ? [
            confirmCommand(commitment, nowIso),
            { type: 'Postpone', commitmentId: commitment.id, postponedUntil: tomorrowFrom(now), now: nowIso },
        ]
        : [{ type: 'Postpone', commitmentId: commitment.id, postponedUntil: tomorrowFrom(now), now: nowIso }];
    case 'skip':
      return [{ type: 'Deprioritize', commitmentId: commitment.id, now: nowIso }];
  }
}

function aggregateResult(results: readonly CommandServiceResult[]): CommandServiceResult['result'] {
  if (results.some((result) => result.result === 'rejected')) return 'rejected';
  if (results.some((result) => result.result === 'applied')) return 'applied';
  return 'noop';
}

function successMessage(action: AgendaActionType, wasDraftLike: boolean): string {
  if (action === 'done') return wasDraftLike ? 'Saved and marked complete.' : 'Marked complete.';
  if (action === 'aware') return wasDraftLike ? 'Reminder saved.' : 'Awareness confirmed.';
  if (action === 'postpone') return wasDraftLike ? 'Saved and moved to tomorrow.' : 'Moved to tomorrow.';
  return 'Moved lower for now.';
}

function failureMessage(action: AgendaActionType, result: CommandServiceResult['result']): string {
  if (result === 'rejected') return `Could not ${action} this commitment.`;
  return `No change was applied for ${action}.`;
}

function recordActionFeedback(action: AgendaActionType, now: Date, options: AgendaActionOptions): void {
  if (
    !options.feedbackStore &&
    !options.feedbackScopeId &&
    !options.conversationId &&
    !options.sessionId &&
    !options.userId
  ) {
    return;
  }

  if (action === 'done') {
    recordBehaviorFeedback('action_completed', { ...options, now });
  }
  if (action === 'postpone') {
    recordBehaviorFeedback('action_delayed', { ...options, now });
  }
  if (action === 'skip') {
    recordBehaviorFeedback('suggestion_ignored', { ...options, now });
  }
}

export function applyAgendaAction(
  id: string,
  action: unknown,
  now: Date = new Date(),
  options: AgendaActionOptions = {}
): AgendaActionResult {
  if (!isAgendaActionType(action)) {
    return {
      success: false,
      message: 'Unsupported agenda action.',
    };
  }

  const commitment = getCommandServiceState().commitments[id];
  if (!commitment) {
    return {
      success: false,
      message: 'Commitment not found.',
    };
  }

  const wasDraftLike = isDraftLike(commitment);
  const results = commandsForAction(commitment, action, now).map((command) => applyCommand(command));
  const result = aggregateResult(results);
  if (result === 'applied') {
    recordActionFeedback(action, now, options);
  }

  return {
    success: result === 'applied',
    message: result === 'applied' ? successMessage(action, wasDraftLike) : failureMessage(action, result),
  };
}
