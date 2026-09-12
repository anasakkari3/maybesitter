import { apiRequest } from '../client';
import { commitmentListSchema, commitmentSchema, type Commitment } from '../schemas/common';
import { commitmentActionResultSchema, commitmentDeleteResultSchema } from '../schemas/commitments';
import type { TimePatch } from '../../features/commitments/timePatch';

export function listToday(input: { timezone: string; referenceTime?: string }): Promise<{ items: Commitment[] }> {
  return apiRequest('GET', '/api/mobile/commitments/today', {
    query: { timezone: input.timezone, referenceTime: input.referenceTime },
    schema: commitmentListSchema,
  });
}

export function listUpcoming(input: { timezone: string; referenceTime?: string }): Promise<{ items: Commitment[] }> {
  return apiRequest('GET', '/api/mobile/commitments/upcoming', {
    query: { timezone: input.timezone, referenceTime: input.referenceTime },
    schema: commitmentListSchema,
  });
}

export function getCommitment(id: string): Promise<Commitment> {
  return apiRequest('GET', `/api/mobile/commitments/${encodeURIComponent(id)}`, {
    schema: commitmentSchema,
  });
}

export interface CommitmentPatch extends TimePatch {
  title?: string;
  description?: string | null;
  priority?: 'high' | 'normal' | 'low';
}

/**
 * A partial update.
 *
 * The body is spread from `buildTimePatch` (#208) so a plain time move sends
 * only `dueDate`. The defect that motivated it: sending `reminderTime` on
 * every move silently re-anchored the reminder, so dragging a commitment an
 * hour later also destroyed a lead the user had set deliberately.
 */
export function patchCommitment(id: string, patch: CommitmentPatch): Promise<Commitment> {
  return apiRequest('PATCH', `/api/mobile/commitments/${encodeURIComponent(id)}`, {
    body: patch,
    schema: commitmentSchema,
  });
}

export type CommitmentAction = 'complete' | 'postpone' | 'cancel';

export function actOnCommitment(
  id: string,
  action: CommitmentAction,
  postponedUntil?: string,
): Promise<{ success: boolean; id: string; commitment: Commitment }> {
  return apiRequest('POST', `/api/mobile/commitments/${encodeURIComponent(id)}/actions`, {
    body: { action, ...(postponedUntil ? { postponedUntil } : {}) },
    schema: commitmentActionResultSchema,
  });
}

/**
 * Drops the commitment. `deleted: false, softDeleted: true` comes back: the
 * server keeps it, and the field names say so rather than letting the verb
 * imply an erasure that did not happen.
 */
export function deleteCommitment(id: string) {
  return apiRequest('DELETE', `/api/mobile/commitments/${encodeURIComponent(id)}`, {
    schema: commitmentDeleteResultSchema,
  });
}
