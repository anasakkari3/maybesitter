import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
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

export type CommandServiceResultType = 'applied' | 'noop' | 'rejected';

export interface CommandServiceResult {
  result: CommandServiceResultType;
  newState: DomainState;
  events: DomainEvent[];
}

export interface CommandServiceConfig {
  initialState?: DomainState;
  schedulerStore?: SchedulerStore | null;
  stateFile?: string;
}

let stateFilePath = process.env.MAYBESITTER_DOMAIN_STATE_FILE || path.join(process.cwd(), '.maybesitter', 'domain-state.json');
let currentState: DomainState = loadState(stateFilePath);
let schedulerStore: SchedulerStore | null = null;

function loadState(filePath: string): DomainState {
  if (!existsSync(filePath)) return createEmptyDomainState();
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as DomainState;
  } catch {
    console.error('[commandService] Corrupt state file at', filePath, '— starting fresh.');
    return createEmptyDomainState();
  }
}

function persistState(state: DomainState): void {
  mkdirSync(path.dirname(stateFilePath), { recursive: true });
  const tmp = `${stateFilePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, stateFilePath);
}

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
  if (config.stateFile) stateFilePath = config.stateFile;
  schedulerStore = config.schedulerStore === undefined ? schedulerStore : config.schedulerStore;
  currentState = config.initialState || loadState(stateFilePath);
  persistState(currentState);
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
  persistState(currentState);
  applySchedulerSideEffects(transition.sideEffects, command.now);

  return {
    result: 'applied',
    newState: currentState,
    events: transition.events,
  };
}
