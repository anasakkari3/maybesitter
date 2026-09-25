import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { getAiConsent } from '../../../../../../lib/consents/aiConsentService';
import { moduleDisabledResponse } from '../../../../../../lib/services/mobile/moduleGate';
import {
  DescriptionTooLongError,
  describeProfile,
} from '../../../../../../lib/services/mobile/profileDescribeService';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * Reads a self-description and proposes what it might mean (UC-2.7b, #168).
 *
 * ── Consent is checked here, before the service is even called ───
 *
 * `captureLlmProvider` would refuse anyway — the gate is what makes it the
 * only route to a model (#161). This asks first so the *client* gets
 * `consent_required` rather than an empty list, because those mean different
 * things on the screen: one shows manual entry, the other shows "nothing to
 * suggest". Zero Vertex calls either way.
 *
 * ── The text is in the request and nowhere else ──────────────────
 *
 * Not echoed in the response, not stored on the proposal, not in the audit
 * line. What comes back is the suggestions, which is what the user is about to
 * be asked about.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('memory');
  if (disabled) return disabled;

  let body: { text?: unknown };
  try {
    body = await readJsonBody(request) as typeof body;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  if (await getAiConsent(user.uid) !== 'granted') {
    return Response.json(
      { success: false, error: 'AI processing has not been agreed to', reason: 'consent_required' },
      { status: 403 },
    );
  }

  try {
    const proposal = await describeProfile(user.uid, String(body?.text ?? ''), new Date());
    return Response.json({ success: true, ...proposal });
  } catch (error) {
    if (error instanceof DescriptionTooLongError) {
      return Response.json(
        { success: false, error: error.message, reason: 'description_too_long' },
        { status: 400 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'could not read the description', 500);
  }
}
