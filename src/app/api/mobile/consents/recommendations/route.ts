import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { UnsupportedConsentVersionError } from '../../../../../../lib/consents/consentService';
import { setRecommendationConsent } from '../../../../../../lib/consents/recommendationConsentService';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import type { ConsentLocale, ConsentPlatform } from '../../../../../../src/contracts/v1/consentContracts';

export const dynamic = 'force-dynamic';

const LOCALES: readonly string[] = ['ar', 'he', 'en'];
const PLATFORMS: readonly string[] = ['ios', 'android'];

/**
 * Records an answer to "suggest one next step" (UC-2.9, #170).
 *
 * The same handler shape as UC-2.1 (#161)'s AI consent, deliberately: two
 * equal choices, nothing pre-selected, no third state, and an unknown
 * `version` refused outright rather than upgraded — accepting one would record
 * agreement to words this server cannot produce.
 *
 * The account is the token's. There is no uid in the body and no code path
 * that would read one.
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
    body = await request.json() as typeof body;
  } catch {
    return mobileError('Invalid JSON request body');
  }

  if (body?.state !== 'granted' && body?.state !== 'declined') {
    return Response.json(
      { success: false, error: 'state must be granted or declined', reason: 'invalid_state' },
      { status: 400 },
    );
  }

  try {
    const record = await setRecommendationConsent(user.uid, {
      state: body.state,
      version: String(body.version ?? ''),
      ...(typeof body.locale === 'string' && LOCALES.includes(body.locale)
        ? { locale: body.locale as ConsentLocale }
        : {}),
      ...(typeof body.platform === 'string' && PLATFORMS.includes(body.platform)
        ? { platform: body.platform as ConsentPlatform }
        : {}),
    });
    return Response.json({ success: true, recommendations: record });
  } catch (error) {
    if (error instanceof UnsupportedConsentVersionError) {
      return Response.json(
        { success: false, error: 'unsupported consent version', reason: 'unsupported_version' },
        { status: 400 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'could not record consent');
  }
}
