/**
 * Sign in with Google (UC-1.2 #146).
 *
 * ── Written against the installed version, not the issue ─────────
 *
 * #146's snippet is from an older release. `@react-native-google-signin/
 * google-signin` v16 returns a discriminated union — `{ type: 'success',
 * data: User }` or `{ type: 'cancelled' }` — rather than throwing on
 * cancellation, and its `statusCodes` no longer names `DEVELOPER_ERROR`
 * (Android rejects with the numeric code `10`). Both are handled here as the
 * installed package actually behaves.
 *
 * ── Where the Web Client ID comes from ───────────────────────────
 *
 * Not from an environment variable that has to be set on three EAS profiles
 * and can be forgotten on one of them. Firebase created a Web OAuth client
 * when Google auth was enabled, and its id is already in the committed
 * `firebase/google-services.json` — a public identifier. `app.config.ts`
 * reads it from there and puts it in `extra`, so the button cannot be
 * configured differently from the Firebase project it talks to.
 * `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` still overrides it if it is ever needed.
 *
 * ── No scopes at sign-in ─────────────────────────────────────────
 *
 * Signing in asks for identity and nothing else. Calendar access is requested
 * later, from the screen that needs it, with `addScopes` — so a consent screen
 * listing calendar access never appears in front of somebody who only wanted
 * to sign in.
 */
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import { googleWebClientId } from '../config/env';

/** Thrown for a Google failure the user can be told something useful about. */
export class GoogleSignInUnavailable extends Error {
  constructor(readonly kind: 'playServices' | 'misconfigured') {
    super(kind);
    this.name = 'GoogleSignInUnavailable';
  }
}

let configured = false;

/** True when this build can offer the button at all. */
export function googleSignInAvailable(): boolean {
  return googleWebClientId() !== null;
}

/**
 * Runs once before any other Google call. Calling it twice is harmless;
 * calling `signIn` before it at all is the package's own hard error.
 */
export function configureGoogleSignIn(): void {
  const webClientId = googleWebClientId();
  if (configured || webClientId === null) return;
  GoogleSignin.configure({ webClientId });
  configured = true;
}

export interface GoogleCredential {
  idToken: string;
}

/**
 * Opens the account chooser. Returns null when the user backed out — a
 * cancellation is a decision, not a failure, and must not raise an error
 * message on the sign-in screen.
 */
export async function requestGoogleCredential(): Promise<GoogleCredential | null> {
  configureGoogleSignIn();
  if (!configured) throw new GoogleSignInUnavailable('misconfigured');

  try {
    // No-op on iOS; on Android it offers the Play services update dialog
    // rather than failing with a code the user cannot act on.
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await GoogleSignin.signIn();
    if (response.type === 'cancelled') return null;
    const idToken = response.data.idToken;
    // A success with no token is the package telling us the configuration is
    // wrong — almost always a Web Client ID that is not this project's.
    if (!idToken) throw new GoogleSignInUnavailable('misconfigured');
    return { idToken };
  } catch (error) {
    throw translate(error);
  }
}

/**
 * Asks for extra Google scopes, and returns an access token for them.
 *
 * Separate from sign-in on purpose (UC-1.2 #146 decision): a consent screen
 * listing calendar access must never appear in front of somebody who only
 * wanted to sign in. It appears when they ask for calendar access, from the
 * screen that needs it.
 *
 * Returns null when the user declines. Never log the token.
 */
export async function requestAdditionalScopes(scopes: readonly string[]): Promise<string | null> {
  configureGoogleSignIn();
  if (!configured) throw new GoogleSignInUnavailable('misconfigured');
  try {
    const result = await GoogleSignin.addScopes({ scopes: [...scopes] });
    // `null` means the scopes were already granted; `cancelled` means the user
    // declined. Only the second is a reason to stop.
    if (result && result.type === 'cancelled') return null;
    const tokens = await GoogleSignin.getTokens();
    return tokens.accessToken ?? null;
  } catch (error) {
    throw translate(error);
  }
}

/** Revokes the app's Google access entirely — the demo's "Disconnect". */
export async function revokeGoogleAccess(): Promise<void> {
  if (!configured) return;
  await GoogleSignin.revokeAccess();
}

/**
 * Signs out of Google as well as Firebase, so the next tap shows the account
 * chooser instead of silently signing the same person back in. Someone handing
 * their phone to a partner has to be able to get a different account.
 */
export async function signOutOfGoogle(): Promise<void> {
  if (!configured) return;
  try {
    await GoogleSignin.signOut();
  } catch {
    // Best effort. Firebase sign-out is what actually ends the session, and
    // failing that for a chooser preference would be the wrong trade.
  }
}

function translate(error: unknown): unknown {
  const code = codeOf(error);
  // A second tap while the sheet is open, and a back-out, are both "nothing
  // happened" — they surface as a null credential, not an error.
  if (code === statusCodes.SIGN_IN_CANCELLED || code === statusCodes.IN_PROGRESS) {
    return new GoogleSignInCancelled();
  }
  if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
    return new GoogleSignInUnavailable('playServices');
  }
  // Android's `DEVELOPER_ERROR`, which is nearly always a signing certificate
  // whose SHA-1 is not registered in the Firebase project. There is nothing
  // the user can do, so the copy is generic; the cause is in the README.
  if (code === '10' || code === 'DEVELOPER_ERROR') {
    return new GoogleSignInUnavailable('misconfigured');
  }
  return error;
}

/** The user backed out. Handled, never shown. */
export class GoogleSignInCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'GoogleSignInCancelled';
  }
}

function codeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') return String(code);
  }
  return '';
}
