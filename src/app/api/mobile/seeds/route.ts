import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import {
  SeedNotFoundError,
  SeedValidationError,
  createSeed,
  listSeeds,
} from '../../../../../lib/services/mobile/seedService';
import { moduleDisabledResponse } from '../../../../../lib/services/mobile/moduleGate';
import { mobileError } from '../../../../../lib/services/mobile/response';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * The "Considering / Waiting" surface (#519).
 *
 * Behind the `capture` module gate rather than a gate of its own: a seed is
 * what a capture produced when it produced no commitment, and a build with
 * capture switched off has nothing to offer here either.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('capture');
  if (disabled) return disabled;

  try {
    return Response.json({ items: await listSeeds(user.uid) });
  } catch (error) {
    return mobileError(error instanceof Error ? error.message : 'could not read seeds', 500);
  }
}

/**
 * Keeps a seed the user picked in Review, or one they typed themselves.
 *
 * This is the only writer of a Seed, and it is the boundary the issue's "zero
 * persistent objects before confirm" rests on: proposing a capture writes a
 * proposal and nothing else, and a seed exists only once this route is called
 * with the user's own selection.
 *
 * 201 the first time and 200 for a replay, so a double tap is visible to the
 * client as the same seed rather than as a second one.
 */
export async function POST(request: Request) {
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
    body = await readJsonBody(request) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  try {
    const { seed, replayed } = await createSeed(user.uid, body, new Date().toISOString());
    return Response.json({ success: true, replayed, seed }, { status: replayed ? 200 : 201 });
  } catch (error) {
    if (error instanceof SeedValidationError) {
      return Response.json({ success: false, error: error.message, reason: 'invalid_seed' }, { status: 400 });
    }
    // A proposal that is not this account's answers exactly as one that does
    // not exist, the same rule the memory routes keep.
    if (error instanceof SeedNotFoundError) {
      return Response.json({ success: false, error: 'not found', reason: 'seed_not_found' }, { status: 404 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not keep the seed', 500);
  }
}
