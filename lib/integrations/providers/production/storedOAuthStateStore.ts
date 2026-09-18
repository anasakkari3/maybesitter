/**
 * The production `ProviderOAuthStateStore` (UC-3.3, #187).
 *
 * Between the redirect and the callback there is a document holding the PKCE
 * verifier. It is a secret with a lifetime of minutes, and the one property
 * that matters is that it can be spent exactly once.
 *
 * ── Why the read and the delete are one transaction ──────────────
 *
 * `consume` is specified as "atomically removes and returns". Read-then-delete
 * would let two callbacks arriving together both read the state before either
 * deleted it, and both would then complete an authorization — which is the
 * replay this is supposed to stop. So the delete happens inside the same
 * transaction that read it, and the loser of the race sees nothing.
 *
 * Expiry is checked after the delete, not before: an expired state is still
 * spent. Leaving it behind would let a caller retry a stale `state` value
 * indefinitely and learn, from the difference between "expired" and "unknown",
 * which ones had once been real.
 */
import { PROVIDER_OAUTH_STATES, userSubDoc } from '../../../storage/paths';
import type { StorageAdapter } from '../../../storage/storageAdapter';
import {
  ProviderOAuthError,
  type ProviderOAuthState,
  type ProviderOAuthStateStore,
} from '../providerOAuthLifecycle';
import { docIdForKey } from '../../../storage/paths';

export class StoredProviderOAuthStateStore implements ProviderOAuthStateStore {
  constructor(
    private readonly uid: string,
    private readonly storage: StorageAdapter,
  ) {}

  private path(state: string): string {
    /*
     * The state is hashed into the document id, never stored as one.
     *
     * Two reasons. It is opaque and caller-influenced, so it has no business
     * being a path segment; and it is a bearer value — anyone holding it can
     * complete this authorization — so the stored id is a hash of it, and a
     * leaked index of document names does not hand out usable states.
     *
     * CodeQL reads the SHA-256 here as `js/insufficient-password-hash`. That
     * rule is about passwords, which are low-entropy and need a slow KDF.
     * `beginProviderOAuth` mints this value as `base64url(randomBytes(32))` —
     * 256 uniformly random bits — so there is nothing to brute force and a
     * slow KDF would buy latency and no security. An HMAC would add key
     * management for the same zero gain at this entropy. The alert is
     * dismissed with this reasoning rather than the code being reshaped to
     * please the heuristic.
     */
    return userSubDoc(this.uid, PROVIDER_OAUTH_STATES, docIdForKey(state));
  }

  async create(value: ProviderOAuthState): Promise<void> {
    if (value.scopeId !== this.uid) {
      throw new ProviderOAuthError('invalid_request');
    }
    const path = this.path(value.state);
    await this.storage.runTransaction(async (tx) => {
      // A collision means a state value was reused, which is the one thing a
      // nonce must never do. `MemoryProviderOAuthStateStore` refuses it too.
      const existing = await tx.get<ProviderOAuthState>(path);
      if (existing) throw new ProviderOAuthError('invalid_request');
      tx.set(path, value);
    });
  }

  async consume(state: string, now: string): Promise<ProviderOAuthState | null> {
    if (typeof state !== 'string' || state.trim() === '') return null;
    const path = this.path(state);
    const value = await this.storage.runTransaction(async (tx) => {
      const stored = await tx.get<ProviderOAuthState>(path);
      // Spent either way. An expired state does not survive to be retried.
      if (stored) tx.delete(path);
      return stored ?? null;
    });
    if (!value) return null;
    const nowMs = Date.parse(now);
    const expiresAtMs = Date.parse(value.expiresAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;
    // A state minted for another account is not this account's to spend.
    if (value.scopeId !== this.uid) return null;
    return value;
  }
}
