import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { moduleDisabledResponse } from '../../../../../lib/services/mobile/moduleGate';
import { mobileError } from '../../../../../lib/services/mobile/response';
import { readAiContextImportReceipt } from '../../../../../lib/services/mobile/aiContextImportService';
import { readRoutineProfile } from '../../../../../lib/services/mobile/routineProfileService';

export const dynamic = 'force-dynamic';

/**
 * The account's routine profile (UC-2.7a, #167).
 *
 * `routine: null` is the honest answer for somebody who has never answered the
 * survey, and it is distinct from a saved profile with `surveySkipped: true` —
 * the app shows the survey for the first and does not for the second.
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
    const routine = await readRoutineProfile(user.uid);
    // `null` for an account that has never brought context over, which is what
    // the Settings row distinguishes: an invitation, or a date.
    const aiContextImport = await readAiContextImportReceipt(user.uid);
    return Response.json({ routine, updatedAt: routine?.updatedAt ?? null, aiContextImport });
  } catch (error) {
    return mobileError(error instanceof Error ? error.message : 'could not read the profile', 500);
  }
}
