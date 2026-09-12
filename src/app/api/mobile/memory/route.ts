import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import {
  MemoryValidationError,
  createManualMemory,
  deleteAllMemory,
  listMemory,
} from '../../../../../lib/services/mobile/memoryService';
import { moduleDisabledResponse } from '../../../../../lib/services/mobile/moduleGate';
import { mobileError } from '../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

/** Everything MaybeSitter currently believes about this account, newest first. */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('memory');
  if (disabled) return disabled;

  try {
    return Response.json({ items: await listMemory(user.uid, new Date().toISOString()) });
  } catch (error) {
    return mobileError(error instanceof Error ? error.message : 'could not read memory', 500);
  }
}

/** A fact the user typed themselves. `source` is never taken from the body. */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('memory');
  if (disabled) return disabled;

  let body: { kind?: unknown; content?: unknown; language?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return mobileError('Invalid JSON request body');
  }

  try {
    const created = await createManualMemory(
      user.uid,
      { kind: body?.kind, content: body?.content, language: body?.language },
      new Date().toISOString(),
    );
    return Response.json({ success: true, memory: created }, { status: 201 });
  } catch (error) {
    if (error instanceof MemoryValidationError) {
      return Response.json({ success: false, error: error.message, reason: 'invalid_memory' }, { status: 400 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not save the fact', 500);
  }
}

/**
 * "Delete all memory" (UC-2.7a, #167).
 *
 * A real delete of every record in the account's tree, whatever its status —
 * superseded and revoked history included. Leaving history behind would make
 * the button's own label untrue.
 */
export async function DELETE(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('memory');
  if (disabled) return disabled;

  try {
    const deleted = await deleteAllMemory(user.uid, new Date().toISOString());
    return Response.json({ success: true, deleted });
  } catch (error) {
    return mobileError(error instanceof Error ? error.message : 'could not delete memory', 500);
  }
}
