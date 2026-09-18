/**
 * The production `ProviderOAuthStateStore` (UC-3.3, #187).
 *
 * Between the redirect and the callback there is a document describing one
 * authorization in flight. Two things about it are secrets — the `state`,
 * which is the bearer value that lets a callback complete the authorization,
 * and the PKCE `codeVerifier`, which is what proves the callback belongs to
 * the redirect that started it. Neither is persisted in the clear.
 *
 * ── What is stored, and what is not ──────────────────────────────
 *
 * The raw `state` is **not a field**. It is the input to the document id, and
 * nothing else: `docId = SHA-256(state)`. A callback arrives holding the state,
 * hashes it, and that is how the record is found. So the stored document does
 * not contain the value that would let someone else complete the flow, and a
 * leaked *index* of document names yields hashes rather than usable states.
 *
 * Hashing the id alone would not have been enough, and an earlier version of
 * this file got that wrong: it stored the whole `ProviderOAuthState`, raw
 * `state` and verifier included, while claiming the state was not stored.
 * Anyone who could read the document could then finish the authorization. The
 * verifier is now encrypted at rest through
 * `lib/security/fieldEncryption.ts` — the same envelope encryption the
 * credential vault uses, bound to the account by AAD — and the raw state is
 * not written at all.
 *
 * SHA-256 is right for the id and a slow KDF would be wrong. `beginProviderOAuth`
 * mints the state as `base64url(randomBytes(32))`: 256 uniformly random bits,
 * with nothing to brute force. A password KDF buys latency and no security at
 * that entropy, and an HMAC would add key management for the same zero gain.
 *
 * ── Why the read and the delete are one transaction ──────────────
 *
 * `consume` is specified as "atomically removes and returns". Read-then-delete
 * would let two callbacks arriving together both read the state before either
 * deleted it, and both would then complete an authorization — which is the
 * replay this is supposed to stop. So the delete happens inside the same
 * transaction that read it, and the loser of the race sees nothing.
 *
 * Everything after the transaction — expiry, scope, decryption — can only turn
 * a consumed state into `null`. It never puts one back. An expired state is
 * spent; a state whose verifier will not decrypt is spent. Restoring either
 * would hand an attacker a retry, and the difference between "expired" and
 * "unknown" is itself something worth not telling them.
 */
import {
  decryptField,
  encryptField,
  fieldPurpose,
  isEncryptedField,
  type EncryptedField,
  type FieldEncryptionOptions,
} from '../../../security/fieldEncryption';
import { PROVIDER_OAUTH_STATES, docIdForKey, userSubDoc } from '../../../storage/paths';
import type { StorageAdapter } from '../../../storage/storageAdapter';
import {
  ProviderOAuthError,
  type ProviderOAuthState,
  type ProviderOAuthStateStore,
} from '../providerOAuthLifecycle';
import type {
  ContextProviderKind,
  IntegrationCapability,
} from '../../../../src/contracts/v1/integrationConnectionContracts';

/**
 * What is written. There is no `state` field, by design.
 *
 * The fields that remain describe the authorization — which provider, which
 * scopes, where it will come back to — and none of them lets anybody complete
 * it. The one secret, the verifier, is a ciphertext.
 */
interface StoredOAuthStateDocument {
  readonly version: 1;
  readonly provider: ContextProviderKind;
  readonly scopeId: string;
  readonly capabilities: readonly IntegrationCapability[];
  readonly requestedScopes: readonly string[];
  readonly redirectUri: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly verifier: EncryptedField;
}

/**
 * The AAD `purpose`, bound to this one authorization.
 *
 * Keyed by the document id — the state's hash — so a verifier cannot be lifted
 * out of one in-flight authorization and replayed inside another, even within
 * the same account. Paired with the uid by `encryptField`, which is what makes
 * a document copied between accounts fail to decrypt.
 */
function verifierPurpose(docId: string): string {
  return fieldPurpose('provider-oauth-state', docId);
}

export class StoredProviderOAuthStateStore implements ProviderOAuthStateStore {
  constructor(
    private readonly uid: string,
    private readonly storage: StorageAdapter,
    private readonly options: FieldEncryptionOptions = {},
  ) {}

  /** `docId = SHA-256(state)`. The raw state never becomes a path segment. */
  private docId(state: string): string {
    return docIdForKey(state);
  }

  private path(docId: string): string {
    return userSubDoc(this.uid, PROVIDER_OAUTH_STATES, docId);
  }

  async create(value: ProviderOAuthState): Promise<void> {
    if (value.scopeId !== this.uid) throw new ProviderOAuthError('invalid_request');
    if (typeof value.state !== 'string' || value.state.trim() === '') {
      throw new ProviderOAuthError('invalid_request');
    }
    if (typeof value.codeVerifier !== 'string' || value.codeVerifier.trim() === '') {
      throw new ProviderOAuthError('invalid_request');
    }
    const docId = this.docId(value.state);
    // Encrypted before the transaction: this is a KMS round trip, and a
    // transaction body must stay pure so it can be retried on contention.
    const verifier = await encryptField(
      this.uid,
      verifierPurpose(docId),
      value.codeVerifier,
      this.options,
    );
    const document: StoredOAuthStateDocument = {
      version: 1,
      provider: value.provider,
      scopeId: value.scopeId,
      capabilities: value.capabilities,
      requestedScopes: value.requestedScopes,
      redirectUri: value.redirectUri,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      verifier,
    };
    const path = this.path(docId);
    await this.storage.runTransaction(async (tx) => {
      // A collision means a state value was reused, which is the one thing a
      // nonce must never do. `MemoryProviderOAuthStateStore` refuses it too.
      const existing = await tx.get<StoredOAuthStateDocument>(path);
      if (existing) throw new ProviderOAuthError('invalid_request');
      tx.set(path, document);
    });
  }

  async consume(state: string, now: string): Promise<ProviderOAuthState | null> {
    if (typeof state !== 'string' || state.trim() === '') return null;
    const docId = this.docId(state);
    const path = this.path(docId);

    const stored = await this.storage.runTransaction(async (tx) => {
      const value = await tx.get<StoredOAuthStateDocument>(path);
      // Spent either way. Nothing below this line ever writes it back.
      if (value) tx.delete(path);
      return value ?? null;
    });
    if (!stored) return null;

    const nowMs = Date.parse(now);
    const expiresAtMs = Date.parse(stored.expiresAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;
    // A state minted for another account is not this account's to spend.
    if (stored.scopeId !== this.uid) return null;
    if (!isEncryptedField(stored.verifier)) return null;

    let codeVerifier: string;
    try {
      codeVerifier = await decryptField(this.uid, verifierPurpose(docId), stored.verifier, this.options);
    } catch {
      // Fail closed. A verifier that will not decrypt — wrong account,
      // corrupted ciphertext, a rotated key that no longer opens it — means
      // this authorization cannot be completed, and the state stays spent.
      // The error is swallowed rather than surfaced because it would describe
      // a secret's ciphertext, and the caller's answer is the same either way.
      return null;
    }

    // The raw state comes from the callback, which is the only place it exists
    // outside memory. The record never held it.
    return Object.freeze({
      state,
      scopeId: stored.scopeId,
      provider: stored.provider,
      capabilities: stored.capabilities,
      requestedScopes: stored.requestedScopes,
      redirectUri: stored.redirectUri,
      codeVerifier,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
    });
  }
}
