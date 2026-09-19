import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import {
  beginGoogleConnect,
  GoogleConnectError,
} from '../../../../../../../lib/integrations/gmail/production/googleConnectService';
import { getStorage } from '../../../../../../../lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Start connecting a Gmail account (Gmail Phase B).
 *
 * Returns the URL the app opens. The app must then intercept the redirect and
 * POST `code` and `state` to the callback with its own bearer token — see the
 * module comment on `googleConnectService` for why the callback cannot be a
 * plain browser GET.
 *
 * POST rather than GET because it writes: every call mints a new state and
 * stores an in-flight authorization record.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    const begun = await beginGoogleConnect(user.uid, { storage: getStorage() });
    return Response.json({ success: true, ...begun });
  } catch (error) {
    return googleConnectErrorResponse(error);
  }
}

/**
 * One shape for every refusal: `reason` is the machine-readable code and
 * `error` is the same string, matching what the rest of `/api/mobile` returns.
 * Nothing derived from Google's response body ever reaches it.
 */
export function googleConnectErrorResponse(error: unknown): Response {
  if (error instanceof GoogleConnectError) {
    return Response.json(
      { success: false, error: error.reason, reason: error.reason },
      { status: error.status },
    );
  }
  return Response.json(
    { success: false, error: 'provider_unavailable', reason: 'provider_unavailable' },
    { status: 502 },
  );
}
