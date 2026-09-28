/**
 * The Firebase half of revoking Sign in with Apple (App Store 5.1.1(v)).
 *
 * `appleRevocation.test.tsx` holds the deletion flow to the order and the
 * failure rules against the fake repository. This file holds the real
 * repository to the two facts that flow relies on: a re-authentication hands
 * back Apple's one-time `authorizationCode`, and `revokeAppleToken` passes it
 * to `@react-native-firebase/auth`'s `revokeToken` for the current app's Auth.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockAuth = { currentUser: { uid: 'apple-user', providerData: [{ providerId: 'apple.com' }] } };
const mockRevokeToken = jest.fn(async (_auth: unknown, _code: string) => undefined);
const mockSignIn = jest.fn(async (): Promise<unknown> => ({
  identityToken: 'apple-identity-token',
  authorizationCode: 'apple-one-time-code',
  fullName: null,
}));
const mockReauthenticate = jest.fn(async (_user: unknown, _credential: unknown) => undefined);

jest.mock('@react-native-firebase/auth', () => ({
  getAuth: () => mockAuth,
  getIdToken: async () => null,
  onAuthStateChanged: () => () => {},
  reload: async () => {},
  signOut: async () => {},
  connectAuthEmulator: () => undefined,
  reauthenticateWithCredential: (user: unknown, credential: unknown) => mockReauthenticate(user, credential),
  revokeToken: (target: unknown, code: string) => mockRevokeToken(target, code),
  OAuthProvider: function MockOAuthProvider() {
    return { credential: (input: unknown) => ({ input }) };
  },
  EmailAuthProvider: { credential: () => ({}) },
  GoogleAuthProvider: { credential: () => ({}) },
}));

jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: async () => true,
  signInAsync: () => mockSignIn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));

const ORIGINAL = process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED;

beforeEach(() => {
  process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED = 'true';
  mockRevokeToken.mockClear();
  mockReauthenticate.mockClear();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED;
  else process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED = ORIGINAL;
});

describe('Sign in with Apple revocation, through the real repository', () => {
  it('re-authentication hands back the fresh authorization code', async () => {
    const { createFirebaseAuthRepository } = require('../firebaseAuthRepository') as typeof import('../firebaseAuthRepository');
    const result = await createFirebaseAuthRepository().reauthenticateWithApple();
    expect(mockReauthenticate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ authorizationCode: 'apple-one-time-code' });
  });

  it('revokes through Firebase with exactly that code', async () => {
    const { createFirebaseAuthRepository } = require('../firebaseAuthRepository') as typeof import('../firebaseAuthRepository');
    await createFirebaseAuthRepository().revokeAppleToken('apple-one-time-code');
    expect(mockRevokeToken).toHaveBeenCalledWith(mockAuth, 'apple-one-time-code');
  });

  it('requestAppleCredential carries the code, and null when Apple sends none', async () => {
    const { requestAppleCredential } = require('../appleSignIn') as typeof import('../appleSignIn');
    await expect(requestAppleCredential()).resolves.toMatchObject({ authorizationCode: 'apple-one-time-code' });
    mockSignIn.mockResolvedValueOnce({ identityToken: 't', authorizationCode: null, fullName: null });
    await expect(requestAppleCredential()).resolves.toMatchObject({ authorizationCode: null });
  });
});
