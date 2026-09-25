import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import {
  SeedAlreadyResolvedError,
  SeedNotFoundError,
  SeedValidationError,
  promoteSeed,
} from '../../../../../../../lib/services/mobile/seedService';
import { moduleDisabledResponse } from '../../../../../../../lib/services/mobile/moduleGate';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * "Turn into a task" and "Turn into a goal" (#519).
 *
 * The one path from a Seed to anything else, and it exists only because the
 * user pressed it. It delegates: a commitment is built by the same
 * `mapExtractionToCommand` → `applyParticipantCommands` → `ConfirmCommitment`
 * sequence every captured commitment goes through, and a goal is #168's
 * confirmed-goal record. There is no parallel storage behind either.
 *
 * A second press answers 200 with `replayed: true` and the promotion that
 * already happened, rather than creating a twin.
 */
export async function POST(request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('capture');
  if (disabled) return disabled;

  let body: { target?: unknown };
  try {
    body = await readJsonBody(request) as typeof body;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  /*
   * A goal is a memory record (#168), and the memory module has its own flag.
   * Without this check a build with memory switched off would answer 200 to
   * "Turn into a goal", write a goal, mark the seed promoted — and the user
   * would have no screen on which to see any of it, because every memory route
   * answers 404. A promotion into something invisible is worse than a refusal,
   * and the refusal is the same 404 the rest of the module gives.
   */
  if (body?.target === 'goal') {
    const memoryDisabled = moduleDisabledResponse('memory');
    if (memoryDisabled) return memoryDisabled;
  }

  const { id } = await context.params;
  try {
    const { seed, replayed } = await promoteSeed(user.uid, id, body?.target, new Date().toISOString());
    return Response.json({ success: true, replayed, seed });
  } catch (error) {
    if (error instanceof SeedNotFoundError) {
      return Response.json({ success: false, error: 'not found', reason: 'seed_not_found' }, { status: 404 });
    }
    if (error instanceof SeedValidationError) {
      return Response.json({ success: false, error: error.message, reason: 'invalid_seed' }, { status: 400 });
    }
    // The user dropped it on purpose. Answering 409 rather than 404 so the app
    // can say "this one is gone" instead of pretending it never existed.
    if (error instanceof SeedAlreadyResolvedError) {
      return Response.json({ success: false, error: error.message, reason: 'seed_resolved' }, { status: 409 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not promote the seed', 500);
  }
}
