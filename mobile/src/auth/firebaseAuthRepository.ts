/**
 * The real `AuthRepository`, over `@react-native-firebase/auth`'s modular API.
 *
 * This is the only module in the app that imports the Firebase auth SDK, and
 * the only one that can produce an ID token. Two rules hold here and are
 * checked by `src/auth/__tests__/noTokenLogging.test.ts`:
 *
 *  1. no token, credential or error payload is ever passed to `console.*`;
 *  2. the token is never written anywhere but the outgoing Authorization
 *     header — the SDK's own keychain/keystore entry is the only copy on disk.
 */
import {
  createUserWithEmailAndPassword,
  getAuth,
  getIdToken as firebaseGetIdToken,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  GoogleAuthProvider,
  OAuthProvider,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
  type User as FirebaseUser,
} from '@react-native-firebase/auth';
import { AppleSignInCancelled, requestAppleCredential } from './appleSignIn';
import { requestGoogleCredential, signOutOfGoogle } from './googleSignIn';
import { normalizeEmail } from './validation';
import type { AuthRepository, AuthUser, SignOutReason } from './types';

export function toAuthUser(user: FirebaseUser | null): AuthUser | null {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    providerIds: user.providerData.map((provider: { providerId: string }) => provider.providerId),
  };
}

export function createFirebaseAuthRepository(): AuthRepository {
  // Firebase has no notion of *why* a session ended, so the repository keeps
  // it — for this process only, never on disk.
  let signOutReason: SignOutReason | null = null;

  return {
    onChange(callback) {
      return onAuthStateChanged(getAuth(), user => {
        if (user) signOutReason = null;
        callback(toAuthUser(user));
      });
    },
    lastSignOutReason: () => signOutReason,
    currentUser() {
      return toAuthUser(getAuth().currentUser);
    },
    async getIdToken(force = false) {
      const user = getAuth().currentUser;
      if (!user) return null;
      try {
        return await firebaseGetIdToken(user, force);
      } catch {
        // A refresh that fails is not an error the user can act on here: the
        // caller turns a missing token into the 401 path, which signs out with
        // `session_expired`. Swallowing the SDK error also keeps its message —
        // which can carry the request payload — out of any handler above.
        return null;
      }
    },
    async reloadUser() {
      const user = getAuth().currentUser;
      if (user) await reload(user);
    },
    async signOut(options) {
      signOutReason = options?.reason ?? 'user';
      // Google first, so the next tap shows the account chooser rather than
      // silently signing the same person back in (UC-1.2 #146). It is best
      // effort: Firebase sign-out is what actually ends the session.
      await signOutOfGoogle();
      await firebaseSignOut(getAuth());
    },

    async signInWithApple() {
      let credential;
      try {
        credential = await requestAppleCredential();
      } catch (error) {
        // Dismissing the sheet leaves the screen exactly as it was.
        if (error instanceof AppleSignInCancelled) return;
        throw error;
      }
      if (!credential) return;
      // The raw nonce goes to Firebase; Apple only ever saw its SHA-256.
      // Firebase hashes this and compares it with the token's `nonce` claim,
      // which is what makes a captured token unusable elsewhere.
      const result = await signInWithCredential(
        getAuth(),
        new OAuthProvider('apple.com').credential({
          idToken: credential.identityToken,
          rawNonce: credential.rawNonce,
        }),
      );
      // Apple sends the name on the first authorisation and never again, so a
      // name that arrives has to be stored now or it is lost for good.
      if (credential.fullName && result.user && !result.user.displayName) {
        await updateProfile(result.user, { displayName: credential.fullName });
      }
    },

    async signInWithGoogle() {
      const credential = await requestGoogleCredential();
      // Null means the user closed the chooser. Nothing happened, and the
      // screen stays exactly as it was.
      if (!credential) return;
      await signInWithCredential(getAuth(), GoogleAuthProvider.credential(credential.idToken));
    },

    async createAccount(email, password) {
      const credential = await createUserWithEmailAndPassword(getAuth(), normalizeEmail(email), password);
      // Sent immediately rather than on a later screen: the one moment the
      // user is certainly looking at their inbox is just after signing up.
      // Product access does not wait on it (UC-1.3 #147).
      if (credential.user && !credential.user.emailVerified) {
        await sendEmailVerification(credential.user);
      }
    },

    async signInWithEmail(email, password) {
      await signInWithEmailAndPassword(getAuth(), normalizeEmail(email), password);
    },

    async sendPasswordReset(email) {
      try {
        await sendPasswordResetEmail(getAuth(), normalizeEmail(email));
      } catch (error) {
        // `auth/user-not-found` is the enumeration oracle: it answers "is this
        // person a user?" to anyone who asks. It is swallowed, so the screen
        // shows the same "check your inbox" either way. Anything else — an
        // invalid address, a rate limit, no network — is still the user's to
        // see, so it is rethrown.
        if (isUserNotFound(error)) return;
        throw error;
      }
    },

    async sendVerificationEmail() {
      const user = getAuth().currentUser;
      if (!user) throw new Error('no signed-in user');
      await sendEmailVerification(user);
    },
  };
}

function isUserNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'auth/user-not-found' || code === 'auth/invalid-credential';
}
