/**
 * The system-browser half of connecting Google and picking a Drive file (CL6a).
 *
 * ── Why an auth session, not native Google Sign-In ───────────────
 *
 * The app already signs people in with Google (`src/auth/googleSignIn.ts`),
 * but that grant belongs to Firebase Auth: its client, its scopes, and a
 * server auth code the backend was never set up to redeem. The three features
 * need a *separate*, revocable grant held by the server (KMS-encrypted, with
 * a refresh token), asked for one scope at a time. A web-server OAuth flow in
 * `WebBrowser.openAuthSessionAsync` does exactly that with the owner's one Web
 * OAuth client, and works the same on iOS (ASWebAuthenticationSession) and
 * Android (Custom Tabs), with no native module to add.
 *
 * ── What crosses back ────────────────────────────────────────────
 *
 * The session ends on `maybesitter://oauth/google…`. The server's redirect
 * page put at most three things there — `code`, `state`, or a closed `error`;
 * for the picker, `fileId`, `cancelled` or `error`. This reads those and
 * nothing else, and never logs the URL: it carries a one-time code.
 * `links.ts` ignores these paths, so the app's own deep-link router does not
 * act on them.
 */
import * as WebBrowser from 'expo-web-browser';

/** The query of a URL as a plain record. `URL` in React Native is partial, so this is done by hand. */
export function queryOf(url: string): Record<string, string> {
  const at = url.indexOf('?');
  if (at < 0) return {};
  const out: Record<string, string> = {};
  for (const pair of url.slice(at + 1).split('#')[0]!.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(key.replace(/\+/g, ' '))] = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      // A malformed escape is not a value this flow can use.
    }
  }
  return out;
}

export type ConnectReturn =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: 'access_denied' | 'failed' }
  | { kind: 'cancelled' };

/** What Google's redirect handed back, reduced to the three things it may be. */
export function readConnectReturn(url: string | null): ConnectReturn {
  if (url === null) return { kind: 'cancelled' };
  const query = queryOf(url);
  if (query.error !== undefined) return { kind: 'error', error: query.error === 'access_denied' ? 'access_denied' : 'failed' };
  if (query.code && query.state) return { kind: 'code', code: query.code, state: query.state };
  return { kind: 'error', error: 'failed' };
}

export type PickReturn =
  | { kind: 'file'; fileId: string }
  | { kind: 'expired' }
  | { kind: 'failed' }
  | { kind: 'cancelled' };

/** Drive file ids are URL-safe tokens; anything else is refused before it becomes a request. */
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

export function readPickReturn(url: string | null): PickReturn {
  if (url === null) return { kind: 'cancelled' };
  const query = queryOf(url);
  if (query.cancelled !== undefined) return { kind: 'cancelled' };
  if (query.error === 'expired') return { kind: 'expired' };
  if (query.fileId && FILE_ID.test(query.fileId)) return { kind: 'file', fileId: query.fileId };
  return { kind: 'failed' };
}

/**
 * Opens `url` in an auth session and resolves with the URL it ended on, or
 * null when the person closed it.
 *
 * Not ephemeral on purpose: a Testing-mode grant lapses every seven days, and
 * «أعد الربط» should be one tap on an account the browser already knows, not
 * a password typed weekly. Consent is still asked every time
 * (`prompt=consent` on the server's URL).
 */
export async function openGoogleSession(url: string, returnUrl: string): Promise<string | null> {
  const result = await WebBrowser.openAuthSessionAsync(url, returnUrl);
  return result.type === 'success' ? result.url : null;
}
