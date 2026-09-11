/**
 * Shared, process-local domain state for the legacy routes (UC-1.0c, #142).
 *
 * ── What was deleted here, and why ───────────────────────────────
 *
 * This module used to mirror one global `DomainState` into
 * `<MAYBESITTER_DATA_DIR>/domain-state.json` on every applied command. That
 * file was the single worst thing in the storage audit: one document holding
 * *every* user's commitments, rewritten whole on each write, on a filesystem
 * that Cloud Run gives each instance separately and throws away with the
 * revision. Two instances would fork the world and the later writer would win
 * silently.
 *
 * The file is gone. Nothing in this module touches a disk any more, so there
 * is no shared state to lose and nothing for `MAYBESITTER_DATA_DIR` to point
 * at. What remains is an in-process `DomainState` for the legacy dev routes,
 * which is honest about being per-process.
 *
 * The launch path does not come through here at all: every mobile request
 * carries a `participantId` and reads and writes `users/{uid}` through
 * `lib/services/mobile/participantState`, which is transactional and durable.
 *
 * ── The guard, and where it is not ───────────────────────────────
 *
 * `configureCommandService` is the bootstrap for that shared, user-less state,
 * so it refuses to run on Cloud Run. The *readers* below are deliberately not
 * guarded: `getCommandServiceState()` is a default argument in agenda,
 * pressure and adaptive services that the participant-scoped path overrides by
 * passing state explicitly, and throwing there would break launch-path
 * requests that never intended to use global state. UC-1.0e (#144) removes the
 * no-participant branch entirely.
 */
import { randomUUID } from 'crypto';
import {
  applyCommand as applyDomainCommand,
  createEmptyDomainState,
  InvalidStateTransitionError,
  MissingEntityError,
  ValidationError,
} from '../../src/domain/stateMachine';
import type {
  Command,
  DomainEvent,
  DomainState,
  SideEffect,
  StateTransitionResult,
} from '../../src/domain/stateMachine';
import type { NewScheduledJob, SchedulerStore } from '../../src/scheduler/jobRunner';
import { assertNotCloudRun } from '../runtime/assertNotCloudRun';

export type CommandServiceResultType = 'applied' | 'noop' | 'rejected';

export interface CommandServiceResult {
  result: CommandServiceResultType;
  newState: DomainState;
  events: DomainEvent[];
}

export interface CommandServiceConfig {
  initialState?: DomainState;
  schedulerStore?: SchedulerStore | null;
}

let currentState: DomainState = createEmptyDomainState();
let schedulerStore: SchedulerStore | null = null;

function createJobFromSideEffect(sideEffect: SideEffect, fallbackRunAt: string): NewScheduledJob | null {
  if (sideEffect.type === 'schedule_reminder') {
    return {
      id: randomUUID(),
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: sideEffect.reminderId,
      runAt: sideEffect.runAt,
      payload: { reminderId: sideEffect.reminderId, requiresAction: true },
    };
  }

  if (sideEffect.type === 'schedule_ignored_check') {
    return {
      id: randomUUID(),
      jobType: 'ignored_check',
      targetType: 'reminder',
      targetId: sideEffect.reminderId,
      runAt: sideEffect.runAt,
      payload: { reminderId: sideEffect.reminderId },
    };
  }

  if (sideEffect.type === 'trigger_escalation') {
    return {
      id: randomUUID(),
      jobType: 'escalation_check',
      targetType: 'commitment',
      targetId: sideEffect.commitmentId,
      runAt: fallbackRunAt,
      payload: { commitmentId: sideEffect.commitmentId },
    };
  }

  return null;
}

function applySchedulerSideEffects(sideEffects: SideEffect[], fallbackRunAt: string): void {
  if (!schedulerStore) return;

  for (const sideEffect of sideEffects) {
    const job = createJobFromSideEffect(sideEffect, fallbackRunAt);
    if (job) schedulerStore.createJob(job);
  }
}

function noopResult(events: DomainEvent[] = []): CommandServiceResult {
  return {
    result: 'noop',
    newState: currentState,
    events,
  };
}

function rejectedResult(): CommandServiceResult {
  return {
    result: 'rejected',
    newState: currentState,
    events: [],
  };
}

export function configureCommandService(config: CommandServiceConfig = {}): void {
  // First use of the shared, user-less state — never module init, so importing
  // this file (which every legacy route does) cannot fail a build or a boot.
  assertNotCloudRun(
    'lib/services/commandService',
    'the global domain state is per-process and shared across every user; the launch path reads '
      + 'and writes users/{uid} through lib/services/mobile/participantState',
  );
  schedulerStore = config.schedulerStore === undefined ? schedulerStore : config.schedulerStore;
  // No file to fall back to: an unconfigured process starts empty rather than
  // inheriting whatever the last one happened to leave on disk.
  currentState = config.initialState || createEmptyDomainState();
}

export function getCommandServiceState(): DomainState {
  return currentState;
}

export function applyCommand(command: Command): CommandServiceResult {
  let transition: StateTransitionResult;
  try {
    transition = applyDomainCommand(currentState, command);
  } catch (error) {
    if (error instanceof InvalidStateTransitionError) return noopResult();
    if (error instanceof MissingEntityError || error instanceof ValidationError) return rejectedResult();
    throw error;
  }

  if (!transition.didChange) {
    return noopResult(transition.events);
  }

  currentState = transition.newState;
  applySchedulerSideEffects(transition.sideEffects, command.now);

  return {
    result: 'applied',
    newState: currentState,
    events: transition.events,
  };
}
