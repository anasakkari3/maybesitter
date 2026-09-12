import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import {
  UnsupportedConsentVersionError,
  setAiConsent,
} from '../../../../../../lib/consents/aiConsentService';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import type { ConsentLocale, ConsentPlatform } from '../../../../../../src/contracts/v1/consentContracts';

export const dynamic = 'force-dynamic';

const LOCALES: readonly string[] = ['ar', 'he', 'en'];
const PLATFORMS: readonly string[] = ['ios', 'android'];

/**
 * Records an answer to the AI-processing question (UC-2.1, #161).
 *
 * Two equal choices, neither pre-selected, and no third state: a client that
 * sends something else gets a 400 rather than a guess. An unknown `version` is
 * refused outright — accepting one would record agreement to words this server
 * cannot produce, which is not consent.
 *
 * The account is the token's. There is no uid in the body and there is no code
 * path that would read one.
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
    const record = await setAiConsent(user.uid, {
      state: body.state,
      version: String(body.version ?? ''),
      ...(typeof body.locale === 'string' && LOCALES.includes(body.locale)
        ? { locale: body.locale as ConsentLocale }
        : {}),
      ...(typeof body.platform === 'string' && PLATFORMS.includes(body.platform)
        ? { platform: body.platform as ConsentPlatform }
        : {}),
    });
    return Response.json({ success: true, aiProcessing: record });
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
