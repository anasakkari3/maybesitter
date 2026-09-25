import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { UnsupportedConsentVersionError } from '../../../../../../lib/consents/consentService';
import {
  PersonalizationConsentNotRecordedError,
  setPersonalizationConsent,
} from '../../../../../../lib/consents/personalizationConsentService';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import type { ConsentLocale, ConsentPlatform } from '../../../../../../src/contracts/v1/consentContracts';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

const LOCALES: readonly string[] = ['ar', 'he', 'en'];
const PLATFORMS: readonly string[] = ['ios', 'android'];

/**
 * Records an answer to "notice patterns in when you finish things"
 * (UC-3.16, #202).
 *
 * The same handler shape as the AI and recommendation consents: two equal
 * answers, nothing pre-selected, an unknown `version` refused rather than
 * upgraded, and the account taken from the token only. The answer is mirrored
 * into the personalization consent store — see
 * `lib/consents/personalizationConsentService.ts` for why both are written and
 * in which order.
 */
export async function PUT(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: { state?: unknown; version?: unknown; locale?: unknown; platform?: unknown };
  try {
    body = await readJsonBody(request) as typeof body;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  if (body?.state !== 'granted' && body?.state !== 'declined') {
    return Response.json(
      { success: false, error: 'state must be granted or declined', reason: 'invalid_state' },
      { status: 400 },
    );
  }

  try {
    const record = await setPersonalizationConsent(user.uid, {
      state: body.state,
      version: String(body.version ?? ''),
      ...(typeof body.locale === 'string' && LOCALES.includes(body.locale)
        ? { locale: body.locale as ConsentLocale }
        : {}),
      ...(typeof body.platform === 'string' && PLATFORMS.includes(body.platform)
        ? { platform: body.platform as ConsentPlatform }
        : {}),
    });
    return Response.json({ success: true, personalization: record });
  } catch (error) {
    if (error instanceof PersonalizationConsentNotRecordedError) {
      return Response.json(
        { success: false, error: 'consent could not be recorded', reason: 'consent_not_recorded' },
        { status: 503 },
      );
    }
    if (error instanceof UnsupportedConsentVersionError) {
      return Response.json(
        { success: false, error: 'unsupported consent version', reason: 'unsupported_version' },
        { status: 400 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'could not record consent');
  }
}
