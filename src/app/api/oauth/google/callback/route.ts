import { oauthCallbackRedirect } from '../../../../../../lib/integrations/google/googleBrowserPages';

export const dynamic = 'force-dynamic';

/**
 * The redirect URI registered on the Google OAuth client (CL6a).
 *
 * Google sends the *browser* here, and a browser carries no Firebase token, so
 * this does not exchange anything: it forwards `code` and `state` (or a closed
 * `error`) to `maybesitter://oauth/google`, where the app's auth session picks
 * them up and POSTs them to `/api/mobile/integrations/google/callback` signed
 * in. The target is a constant, so this is not an open redirect, and nothing
 * is logged.
 */
export function GET(request: Request) {
  return oauthCallbackRedirect(request.url);
}
