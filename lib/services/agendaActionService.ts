import {
  applyCommand,
  getCommandServiceState,
  type CommandServiceResult,
} from './commandService';
import {
  recordBehaviorFeedback,
  scopeBehaviorFeedback,
  type BehaviorFeedbackScopeOptions,
  type BehaviorFeedbackStore,
} from './behaviorFeedbackService';
import { createFileFeedbackEventStore } from '../feedback/feedbackEventStore';
import type { FeedbackEventStore, FeedbackOutcome } from '../../src/contracts/v1/feedbackContracts';
import type { Command, Commitment } from '../../src/domain/stateMachine';

export type AgendaActionType = 'done' | 'aware' | 'postpone' | 'skip';

export interface AgendaActionResult {
  success: boolean;
  message: string;
}

export interface AgendaActionOptions extends BehaviorFeedbackScopeOptions {
  feedbackStore?: BehaviorFeedbackStore;
  /** Injected in tests; defaults to the shared file-backed event store. */
  feedbackEventStore?: FeedbackEventStore;
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

function recordActionFeedback(
  action: AgendaActionType,
  subjectId: string,
  now: Date,
  options: AgendaActionOptions,
): void {
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

  appendFeedbackEvent(action, subjectId, now, options);
}

/**
 * Sprint 03 dual-write: the same outcome is also appended to the event log.
 *
 * The legacy counter write above stays authoritative for this sprint — six
 * modules still read it — so the event log can be verified against a working
 * system before anything depends on it.
 *
 * Ordering and isolation are deliberate. The append runs last and its failure
 * is swallowed, so a fault in the new log leaves the legacy counter written and
 * the user's action applied. The event log is then merely short, which a replay
 * can repair; the reverse — failing the user's action because a
 * not-yet-depended-on log misbehaved — would be a regression caused entirely by
 * unfinished work.
 */
function appendFeedbackEvent(
  action: AgendaActionType,
  subjectId: string,
  now: Date,
  options: AgendaActionOptions,
): void {
  const outcome = FEEDBACK_OUTCOME_BY_ACTION[action];
  if (!outcome) return;

  const store = options.feedbackEventStore ?? defaultFeedbackEventStore();
  const at = now.toISOString();
  try {
    store.append(
      {
        scopeId: scopeBehaviorFeedback(options),
        outcome,
        subjectId,
        actor: 'user',
        source: 'mobile_action',
        occurredAt: at,
      },
      at,
    );
  } catch {
    // See the ordering note above: the legacy write already succeeded.
  }
}

/**
 * `aware` has no outcome: acknowledging that a commitment exists is not yet a
 * decision about it, and recording one would put a behaviour in the log the
 * user never performed.
 */
const FEEDBACK_OUTCOME_BY_ACTION: Readonly<Partial<Record<AgendaActionType, FeedbackOutcome>>> =
  Object.freeze({
    done: 'complete',
    postpone: 'defer',
    skip: 'ignore',
  });

let sharedFeedbackEventStore: FeedbackEventStore | null = null;

function defaultFeedbackEventStore(): FeedbackEventStore {
  sharedFeedbackEventStore ??= createFileFeedbackEventStore();
  return sharedFeedbackEventStore;
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
    recordActionFeedback(action, id, now, options);
  }

  return {
    success: result === 'applied',
    message: result === 'applied' ? successMessage(action, wasDraftLike) : failureMessage(action, result),
  };
}
