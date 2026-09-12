import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { moduleDisabledResponse } from '../../../../../../lib/services/mobile/moduleGate';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { saveRoutineProfile } from '../../../../../../lib/services/mobile/routineProfileService';
import {
  RoutineProfileValidationError,
  parseRoutineProfileInput,
} from '../../../../../../src/contracts/v1/routineContracts';

export const dynamic = 'force-dynamic';

/**
 * Saves the routine survey (UC-2.7a, #167).
 *
 * The account is the token's; there is no uid in the body and no code path
 * that reads one. The whole profile is sent every time rather than a patch:
 * the survey is five answers on one screen and the user's last state is the
 * only thing that means anything, which is also what lets the phone re-send
 * the latest copy after a failed sync without a replay queue.
 */
export async function PUT(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('memory');
  if (disabled) return disabled;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  try {
    const input = parseRoutineProfileInput(body);
    const result = await saveRoutineProfile(user.uid, input, new Date().toISOString());
    return Response.json({ success: true, routine: result.profile, facts: result.facts });
  } catch (error) {
    if (error instanceof RoutineProfileValidationError) {
      return Response.json(
        { success: false, error: error.message, reason: 'invalid_profile' },
        { status: 400 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'could not save the profile', 500);
  }
}
