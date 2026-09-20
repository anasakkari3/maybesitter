import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import {
  SeedNotFoundError,
  SeedValidationError,
  deleteSeed,
  patchSeed,
} from '../../../../../../lib/services/mobile/seedService';
import { moduleDisabledResponse } from '../../../../../../lib/services/mobile/moduleGate';
import { mobileError } from '../../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * An id that is not this account's answers exactly as an id that does not
 * exist. Anything else would confirm the seed is real and somebody's.
 */
function notFound(): Response {
  return Response.json({ success: false, error: 'not found', reason: 'seed_not_found' }, { status: 404 });
}

/**
 * "Later", "Dismiss", and an edit to the sentence (#519).
 *
 * `status` is limited to the four a user can choose. `promoted` is refused
 * here and written only by the promote route, which is what stops a seed from
 * being able to promote itself.
 */
export async function PATCH(request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('capture');
  if (disabled) return disabled;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return mobileError('Invalid JSON request body');
  }

  const { id } = await context.params;
  try {
    const seed = await patchSeed(user.uid, id, body, new Date().toISOString());
    return Response.json({ success: true, seed });
  } catch (error) {
    if (error instanceof SeedNotFoundError) return notFound();
    if (error instanceof SeedValidationError) {
      return Response.json({ success: false, error: error.message, reason: 'invalid_seed' }, { status: 400 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not update the seed', 500);
  }
}

/** Removes the seed outright. Dismissing keeps the row; this does not. */
export async function DELETE(request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('capture');
  if (disabled) return disabled;

  const { id } = await context.params;
  try {
    await deleteSeed(user.uid, id);
    return Response.json({ success: true, deleted: 1 });
  } catch (error) {
    if (error instanceof SeedNotFoundError) return notFound();
    return mobileError(error instanceof Error ? error.message : 'could not delete the seed', 500);
  }
}
