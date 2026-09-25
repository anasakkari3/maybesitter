/**
 * Sign in with Apple (UC-1.1 #145).
 *
 * ── What is here, and what is deliberately not ───────────────────
 *
 * The iOS flow is complete: the native sheet through the first-party
 * `expo-apple-authentication`, the nonce pair, the Firebase credential, and
 * cancellation. It is switched off until `EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED`
 * is set, because none of it can work before the owner has enabled the
 * capability on the App ID and filled the Apple provider in the Firebase
 * console — and a button that can only fail is worse than no button.
 *
 * The **Android** flow is not here. #145 specifies
 * `@invertase/react-native-apple-authentication`'s web flow, which needs a
 * Services ID that does not exist yet. That library is also an
 * old-architecture native module, and adding one to every Android build when
 * it cannot be built, launched or exercised — no Apple credentials, no device
 * — would be unverifiable native code shipped on trust. It is recorded as a
 * remaining engineering item instead, to be done once the credentials exist
 * and it can actually be tested.
 *
 * No Team ID, Key ID, Services ID or `.p8` appears anywhere in this app, and
 * none needs to: those live in the Firebase console, which performs the token
 * exchange.
 */
import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { appleSignInEnabled } from '../config/env';
import { generateNonce, sha256Hex } from './appleNonce';

export class AppleSignInCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'AppleSignInCancelled';
  }
}

export class AppleSignInUnavailable extends Error {
  constructor(readonly kind: 'notConfigured' | 'unsupportedPlatform' | 'noIdentityToken') {
    super(kind);
    this.name = 'AppleSignInUnavailable';
  }
}

export interface AppleCredential {
  identityToken: string;
  /** The raw nonce, for Firebase. Apple only ever saw its SHA-256. */
  rawNonce: string;
  /** Apple sends the name on the first authorisation only, and never again. */
  fullName: string | null;
  /**
   * The one-time code Apple issues with every authorisation. Short-lived and
   * single-use; its only use here is revoking the account's Apple tokens on
   * deletion. Never stored, never logged.
   */
  authorizationCode: string | null;
}

/**
 * Whether the build should render the Apple button at all.
 *
 * `isAvailableAsync()` alone is not enough: it answers true on any iOS 13+
 * device regardless of whether the App ID has the capability, so the button
 * would appear and fail. The env flag is what the owner flips once the portal
 * and Firebase console steps are done.
 */
export async function appleSignInAvailable(): Promise<boolean> {
  if (!appleSignInEnabled()) return false;
  // Android needs the web flow, which is not implemented (see the header).
  if (Platform.OS !== 'ios') return false;
  return AppleAuthentication.isAvailableAsync();
}

export async function requestAppleCredential(): Promise<AppleCredential | null> {
  if (!appleSignInEnabled()) throw new AppleSignInUnavailable('notConfigured');
  if (Platform.OS !== 'ios') throw new AppleSignInUnavailable('unsupportedPlatform');

  const rawNonce = generateNonce();
  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      // Apple gets the hash; Firebase gets the raw value below. Swapping these
      // fails open — sign-in works and the replay protection is simply absent.
      nonce: await sha256Hex(rawNonce),
    });
    if (!credential.identityToken) throw new AppleSignInUnavailable('noIdentityToken');
    return {
      identityToken: credential.identityToken,
      rawNonce,
      fullName: joinName(credential.fullName),
      authorizationCode: credential.authorizationCode ?? null,
    };
  } catch (error) {
    // `ERR_REQUEST_CANCELED` is the user dismissing the sheet. It is a
    // decision, not a failure, and the screen must not change.
    if (isCancellation(error)) throw new AppleSignInCancelled();
    throw error;
  }
}

function joinName(fullName: AppleAuthentication.AppleAuthenticationFullName | null): string | null {
  if (!fullName) return null;
  const joined = [fullName.givenName, fullName.familyName].filter(Boolean).join(' ').trim();
  return joined === '' ? null : joined;
}

function isCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return (error as { code?: unknown }).code === 'ERR_REQUEST_CANCELED';
}
