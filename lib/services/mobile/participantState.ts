import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  applyCommand as applyDomainCommand,
  createEmptyDomainState,
  InvalidStateTransitionError,
  MissingEntityError,
  ValidationError,
  type Command,
  type DomainEvent,
  type DomainState,
} from '../../../src/domain/stateMachine';
import { requirePilotParticipantId } from '../../pilot/closedPilotControls';

export type ParticipantCommandResultType = 'applied' | 'noop' | 'rejected';

export interface ParticipantCommandResult {
  result: ParticipantCommandResultType;
  newState: DomainState;
  events: DomainEvent[];
}

interface RecommendationDecisionRecord {
  fingerprint: string;
  response: unknown;
}

const queues = new Map<string, Promise<unknown>>();

function cloneState(state: DomainState): DomainState {
  return JSON.parse(JSON.stringify(state)) as DomainState;
}

export function participantDataRoot(): string {
  return process.env.MAYBESITTER_DATA_DIR || path.join(process.cwd(), '.maybesitter');
}

export function participantStateFile(participantId: string): string {
  requirePilotParticipantId(participantId);
  return path.join(participantDataRoot(), 'participants', `${participantId}-state.json`);
}

function participantRecommendationActionsFile(participantId: string): string {
  requirePilotParticipantId(participantId);
  return path.join(participantDataRoot(), 'participants', `${participantId}-recommendation-actions.json`);
}

function loadStateFromFile(filePath: string): DomainState {
  if (!existsSync(filePath)) return createEmptyDomainState();
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as DomainState;
  } catch {
    return createEmptyDomainState();
  }
}

function persistStateToFile(filePath: string, state: DomainState): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, filePath);
}

function loadDecisionRecords(participantId: string): Record<string, RecommendationDecisionRecord> {
  const filePath = participantRecommendationActionsFile(participantId);
  if (!existsSync(filePath)) return {};
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, RecommendationDecisionRecord>;
}

function persistDecisionRecords(participantId: string, records: Record<string, RecommendationDecisionRecord>): void {
  const filePath = participantRecommendationActionsFile(participantId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, filePath);
}

export async function withParticipantLock<T>(participantId: string, operation: () => Promise<T> | T): Promise<T> {
  requirePilotParticipantId(participantId);
  const previous = queues.get(participantId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const settled = run.then(() => undefined, () => undefined);
  queues.set(participantId, settled);
  try {
    return await run;
  } finally {
    if (queues.get(participantId) === settled) queues.delete(participantId);
  }
}

export function getParticipantStateSnapshot(participantId: string): DomainState {
  return cloneState(loadStateFromFile(participantStateFile(participantId)));
}

export async function readParticipantState(participantId: string): Promise<DomainState> {
  return withParticipantLock(participantId, () => getParticipantStateSnapshot(participantId));
}

export async function persistParticipantState(participantId: string, state: DomainState): Promise<DomainState> {
  return withParticipantLock(participantId, () => {
    persistStateToFile(participantStateFile(participantId), state);
    return cloneState(state);
  });
}

export async function applyParticipantCommands(
  participantId: string,
  commands: readonly Command[],
): Promise<{ state: DomainState }> {
  return withParticipantLock(participantId, () => {
    let candidate = getParticipantStateSnapshot(participantId);
    for (const command of commands) {
      const transition = applyDomainCommand(candidate, command);
      candidate = transition.newState;
    }
    persistStateToFile(participantStateFile(participantId), candidate);
    return { state: cloneState(candidate) };
  });
}

function noopResult(state: DomainState, events: DomainEvent[] = []): ParticipantCommandResult {
  return { result: 'noop', newState: cloneState(state), events };
}

function rejectedResult(state: DomainState): ParticipantCommandResult {
  return { result: 'rejected', newState: cloneState(state), events: [] };
}

export async function applyParticipantCommand(
  participantId: string,
  command: Command,
): Promise<ParticipantCommandResult> {
  return withParticipantLock(participantId, () => {
    const state = getParticipantStateSnapshot(participantId);
    try {
      const transition = applyDomainCommand(state, command);
      if (!transition.didChange) return noopResult(state, transition.events);
      persistStateToFile(participantStateFile(participantId), transition.newState);
      return {
        result: 'applied',
        newState: cloneState(transition.newState),
        events: transition.events,
      };
    } catch (error) {
      if (error instanceof InvalidStateTransitionError) return noopResult(state);
      if (error instanceof MissingEntityError || error instanceof ValidationError) return rejectedResult(state);
      throw error;
    }
  });
}

export async function deleteParticipantDomainState(participantId: string): Promise<void> {
  return withParticipantLock(participantId, () => {
    const statePath = participantStateFile(participantId);
    const actionsPath = participantRecommendationActionsFile(participantId);
    if (existsSync(statePath)) rmSync(statePath, { force: true });
    if (existsSync(actionsPath)) rmSync(actionsPath, { force: true });
  });
}

export async function replayOrRecordParticipantDecision<T>(
  participantId: string,
  idempotencyKey: string,
  fingerprint: string,
  create: () => T,
): Promise<{ replayed: boolean; response: T }> {
  return withParticipantLock(participantId, () => {
    const records = loadDecisionRecords(participantId);
    const existing = records[idempotencyKey];
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('idempotencyKey body mismatch');
      return { replayed: true, response: existing.response as T };
    }
    const response = create();
    records[idempotencyKey] = { fingerprint, response };
    persistDecisionRecords(participantId, records);
    return { replayed: false, response };
  });
}
