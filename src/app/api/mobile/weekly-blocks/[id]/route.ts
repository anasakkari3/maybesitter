import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { parseWeeklyBlockPatch } from '../../../../../../src/contracts/v1/weeklyBlockContracts';
import { WeeklyBlockValidationError, weeklyBlockValidationResponse } from '../../../../../../lib/weeklyBlocks/weeklyBlockApi';
import {
  deleteWeeklyBlock,
  isWeeklyBlockId,
  patchWeeklyBlock,
  presentWeeklyBlock,
} from '../../../../../../lib/weeklyBlocks/weeklyBlockService';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * Title, days, hours or status (`paused` / `active`).
 *
 * A schedule change re-expands the future and leaves every occurrence that
 * has already ended exactly as it was; a pause removes every occurrence that
 * has not ended. `confirmation` is not patchable: editing is not re-confirming.
 * An id from another account answers 404, like one that never existed.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  const { id } = await context.params;
  if (!isWeeklyBlockId(id)) return mobileError('no such weekly block', 404);
  try {
    const patch = parseWeeklyBlockPatch(body);
    const updated = await patchWeeklyBlock(user.uid, id, patch);
    if (updated === null) return mobileError('no such weekly block', 404);
    return Response.json({ success: true, block: presentWeeklyBlock(updated) });
  } catch (error) {
    if (error instanceof WeeklyBlockValidationError) return weeklyBlockValidationResponse(error);
    console.error('[weekly-blocks] patch failed', error instanceof Error ? error.name : 'unknown');
    return mobileError('could not update the weekly block', 500);
  }
}

/** The block and every occurrence it reserved, past ones included. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { id } = await context.params;
  if (!isWeeklyBlockId(id)) return mobileError('no such weekly block', 404);
  try {
    const deleted = await deleteWeeklyBlock(user.uid, id);
    if (!deleted) return mobileError('no such weekly block', 404);
    return Response.json({ success: true, deleted: true });
  } catch (error) {
    console.error('[weekly-blocks] delete failed', error instanceof Error ? error.name : 'unknown');
    return mobileError('could not delete the weekly block', 500);
  }
}
