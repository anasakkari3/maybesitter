/**
 * Does this uid still have a Firebase account? (UC-1.5, #149)
 *
 * ── Why this exists ──────────────────────────────────────────────
 *
 * Verifying an ID token is offline work: signature, issuer, audience, expiry.
 * It does not ask Firebase whether the account is still there, so a token
 * minted before a deletion keeps verifying until it expires — up to an hour
 * after the user was told they were gone.
 *
 * On its own that is a stale session. What made it worse is that the first
 * authenticated request after a deletion found no `users/{uid}` document and
 * *created one*, which put the account shell back and answered 200. A deletion
 * that the next request undoes is not a deletion.
 *
 * This was invisible in the emulator, which rejects tokens for users it no
 * longer has, and only appeared against real staging. Hence the check, and
 * hence it is enforced in the auth path rather than trusted to the verifier.
 *
 * ── Why it is cheap ──────────────────────────────────────────────
 *
 * It runs only when the uid has no trust record yet: a genuine first sign-in,
 * or exactly the case above. Every later request reads the document and never
 * comes here.
 */

export interface AccountDirectory {
  /** False only for a uid Firebase does not have. Unreachable is an error. */
  exists(uid: string): Promise<boolean>;
}

let directoryForTests: AccountDirectory | null = null;

/**
 * The same seam as `setTokenVerifierForTests`. There is no environment variable
 * and no production path that sets this.
 */
export function setAccountDirectoryForTests(directory: AccountDirectory | null): void {
  directoryForTests = directory;
}

export async function accountExists(uid: string): Promise<boolean> {
  if (directoryForTests) return directoryForTests.exists(uid);
  const [{ getAuth }, { getAdminApp }] = await Promise.all([
    import('firebase-admin/auth'),
    import('../firebase/admin'),
  ]);
  try {
    await getAuth(getAdminApp()).getUser(uid);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'auth/user-not-found') return false;
    // Anything else is Firebase being unreachable. Refusing to answer is the
    // caller's problem to turn into a 503; answering "yes" would be a guess in
    // the direction that admits people.
    throw error;
  }
}
