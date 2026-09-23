import { apiRequest } from '../client';
import {
  goalConfirmResponseSchema,
  goalExecutionResponseSchema,
  goalGraphResponseSchema,
  goalUnlinkResponseSchema,
  type GoalExecution,
  type GoalGraph,
  type GoalConfirmation,
  type GoalProgressPeriod,
} from '../schemas/goals';

const path = (goalId: string, suffix = '') => `/api/mobile/goals/${encodeURIComponent(goalId)}/execution${suffix}`;

export function getGoalExecution(goalId: string, generation = 1, period?: GoalProgressPeriod): Promise<GoalExecution> {
  return apiRequest('GET', path(goalId), {
    query: { generation, fromLocalDate: period?.fromLocalDate, toLocalDate: period?.toLocalDate },
    schema: goalExecutionResponseSchema,
  });
}

export async function generateGoalExecution(goalId: string): Promise<GoalGraph> {
  const response = await apiRequest('POST', path(goalId, '/generate'), { body: {}, schema: goalGraphResponseSchema });
  return response.graph;
}

export async function regenerateGoalExecution(goalId: string, fromGeneration: number): Promise<GoalGraph> {
  const response = await apiRequest('POST', path(goalId, '/regenerate'), { body: { fromGeneration }, schema: goalGraphResponseSchema });
  return response.graph;
}

export async function confirmGoalCommitments(goalId: string, generation: number, nodeIds: readonly string[]): Promise<GoalGraph> {
  const response = await apiRequest('POST', path(goalId, '/confirm'), {
    body: { generation, selections: nodeIds.map(nodeId => ({ nodeId, as: 'commitment' as const })) },
    schema: goalConfirmResponseSchema,
  });
  return response.graph;
}

export type GoalConfirmationSelection =
  | { nodeId: string; as: 'commitment' }
  | { nodeId: string; as: 'habit'; habit: {
    cadence: { kind: 'weekly_count'; count: number };
    durationMinutes: number;
    preferredWindows: readonly { start: string; end: string }[];
    minimumOccurrences: number;
    maximumOccurrences: number;
    flexibility: 'flexible' | 'protected_flexible';
    recoveryPolicy: 'skip' | 'retry_same_day' | 'recover_within_period';
  } };

export function confirmGoalSelections(goalId: string, generation: number, selections: readonly GoalConfirmationSelection[]): Promise<GoalConfirmation> {
  return apiRequest('POST', path(goalId, '/confirm'), {
    body: { generation, selections },
    schema: goalConfirmResponseSchema,
  });
}

export function unlinkGoalNode(goalId: string, nodeId: string) {
  return apiRequest('PATCH', path(goalId, `/nodes/${encodeURIComponent(nodeId)}`), {
    body: { action: 'unlink' },
    schema: goalUnlinkResponseSchema,
  });
}
