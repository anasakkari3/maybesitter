import { apiRequest, apiRequestTagged, type TaggedResult } from '../client';
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

/**
 * One commitment, with the `ETag` a later conditional write needs (#148).
 *
 * The validator is echoed, never built: it is `updatedAt` plus a digest, so a
 * client cannot derive it from the DTO — and must not try, because its shape
 * is the server's to change.
 */
export function getCommitment(id: string): Promise<TaggedResult<Commitment>> {
  return apiRequestTagged('GET', `/api/mobile/commitments/${encodeURIComponent(id)}`, {
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
export function patchCommitment(
  id: string,
  patch: CommitmentPatch,
  /**
   * The `ETag` of the commitment the screen rendered. With it, an edit from a
   * screen that has gone stale is refused with 409 `stale_commitment` instead
   * of silently overwriting a newer change from another device. Without it the
   * write is unconditional, which is what a first write still wants.
   */
  ifMatch?: string,
): Promise<TaggedResult<Commitment>> {
  return apiRequestTagged('PATCH', `/api/mobile/commitments/${encodeURIComponent(id)}`, {
    body: patch,
    schema: commitmentSchema,
    ...(ifMatch ? { ifMatch } : {}),
  });
}

export type CommitmentAction = 'complete' | 'postpone' | 'cancel';

export function actOnCommitment(
  id: string,
  action: CommitmentAction,
  options: { postponedUntil?: string; ifMatch?: string } = {},
): Promise<TaggedResult<{ success: boolean; id: string; commitment: Commitment }>> {
  return apiRequestTagged('POST', `/api/mobile/commitments/${encodeURIComponent(id)}/actions`, {
    body: { action, ...(options.postponedUntil ? { postponedUntil: options.postponedUntil } : {}) },
    schema: commitmentActionResultSchema,
    ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}),
  });
}

/**
 * Drops the commitment. `deleted: false, softDeleted: true` comes back: the
 * server keeps it, and the field names say so rather than letting the verb
 * imply an erasure that did not happen.
 */
export function deleteCommitment(id: string, ifMatch?: string) {
  return apiRequest('DELETE', `/api/mobile/commitments/${encodeURIComponent(id)}`, {
    schema: commitmentDeleteResultSchema,
    ...(ifMatch ? { ifMatch } : {}),
  });
}
