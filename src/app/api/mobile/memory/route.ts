import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import {
  MEMORY_ADAPTIVE_UNSET,
  MemoryDeletionIncompleteError,
  MemoryValidationError,
  createManualMemory,
  deleteAllMemory,
  listMemory,
  readMemoryAdaptive,
} from '../../../../../lib/services/mobile/memoryService';
import { listMemorySuggestions } from '../../../../../lib/memoryGrowth/suggestionService';
import { moduleDisabledResponse } from '../../../../../lib/services/mobile/moduleGate';
import { mobileError } from '../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

/**
 * Everything MaybeSitter currently believes about this account, newest first,
 * what it could suggest it noticed, and how reminders adapt to it (UC-3.16,
 * #202).
 *
 * `suggestions` is computed on this read and written nowhere. It is empty
 * without personalization consent. A failure to compute it never costs the
 * list: seeing and removing what is held must work even when growth cannot.
 *
 * `adaptive` is read the same way — computed on this read, written nowhere —
 * from the account's own behaviour counters. It is shown regardless of
 * personalization consent, on the web inventory's reasoning: consent does not
 * unwrite a classifier that shipped before the consent existed. An account
 * with no behaviour to read gets the neutral unset state, and a failure to
 * read it gets the same, never an error that costs the list.
 */
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
    const now = new Date().toISOString();
    const items = await listMemory(user.uid, now);
    let suggestions: Awaited<ReturnType<typeof listMemorySuggestions>> = [];
    try {
      suggestions = await listMemorySuggestions(user.uid, now);
    } catch (error) {
      console.error('memory suggestions could not be computed', error instanceof Error ? error.message : error);
    }
    let adaptive: Awaited<ReturnType<typeof readMemoryAdaptive>> = MEMORY_ADAPTIVE_UNSET;
    try {
      adaptive = await readMemoryAdaptive(user.uid);
    } catch (error) {
      console.error('adaptive classification could not be read', error instanceof Error ? error.message : error);
    }
    return Response.json({ items, suggestions, adaptive });
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
 * "Delete all memory" (UC-2.7a, #167; the cascade is UC-3.16, #202).
 *
 * A real delete of every record in the account's tree, whatever its status —
 * superseded and revoked history included — and of the behaviour log the
 * personalization profile is derived from. Leaving either behind would make
 * the button's own label untrue, and the derived profile is the half a user
 * has no way of checking.
 *
 * A deletion that did not finish answers 500 with `memory_delete_incomplete`.
 * It must not answer 200: this is the one call whose success the user cannot
 * verify for themselves, so a wrong "done" here is believed.
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
    if (error instanceof MemoryDeletionIncompleteError) {
      return Response.json(
        { success: false, error: error.message, reason: 'memory_delete_incomplete' },
        { status: 500 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'could not delete memory', 500);
  }
}
