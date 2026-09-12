import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import {
  MemoryNotFoundError,
  MemoryValidationError,
  deleteMemory,
  patchMemory,
} from '../../../../../../lib/services/mobile/memoryService';
import { moduleDisabledResponse } from '../../../../../../lib/services/mobile/moduleGate';
import { mobileError } from '../../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * An id that is not this account's answers exactly as an id that does not
 * exist. Anything else would confirm the record is real and somebody's.
 */
function notFound(): Response {
  return Response.json({ success: false, error: 'not found', reason: 'memory_not_found' }, { status: 404 });
}

/** Edits a fact by superseding it, keeping the previous version behind it. */
export async function PATCH(request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('memory');
  if (disabled) return disabled;

  let body: { content?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return mobileError('Invalid JSON request body');
  }

  const { id } = await context.params;
  try {
    const updated = await patchMemory(user.uid, id, body?.content, new Date().toISOString());
    return Response.json({ success: true, memory: updated });
  } catch (error) {
    if (error instanceof MemoryNotFoundError) return notFound();
    if (error instanceof MemoryValidationError) {
      return Response.json({ success: false, error: error.message, reason: 'invalid_memory' }, { status: 400 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not edit the fact', 500);
  }
}

/** Hard-deletes the fact and every record in its supersession chain. */
export async function DELETE(request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('memory');
  if (disabled) return disabled;

  const { id } = await context.params;
  try {
    const deleted = await deleteMemory(user.uid, id, new Date().toISOString());
    return Response.json({ success: true, deleted });
  } catch (error) {
    if (error instanceof MemoryNotFoundError) return notFound();
    return mobileError(error instanceof Error ? error.message : 'could not delete the fact', 500);
  }
}
