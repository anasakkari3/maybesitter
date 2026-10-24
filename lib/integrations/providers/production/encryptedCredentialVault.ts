/**
 * The production `ProviderCredentialVault` (UC-3.3, #187).
 *
 * `completeProviderOAuth` already decides *when* a token set is stored and
 * fetched. This decides *how*, and its entire job is that the stored form is
 * useless to anyone but the account it belongs to.
 *
 * ── Why this is three lines of storage and no cryptography ───────
 *
 * `lib/security/fieldEncryption.ts` already does envelope encryption with a
 * per-value DEK wrapped by KMS, and it was written for exactly this value —
 * "a Google refresh token (#187)" is the first case in its header. Writing a
 * second scheme here would mean a second thing to get wrong, so this calls
 * that one and does no crypto of its own.
 *
 * ── The uid binding ──────────────────────────────────────────────
 *
 * Two independent bindings, because one that silently stops working is worse
 * than none:
 *
 * 1. **The path.** `userSubDoc(uid, …)` puts the ciphertext inside the
 *    account's own tree, so a lookup for another uid reads a different
 *    document and finds nothing.
 * 2. **The AAD.** `encryptField` derives it from the uid and purpose and it is
 *    authenticated by both AES-GCM and the KMS wrap. Copying A's document into B's
 *    tree therefore fails to decrypt rather than handing B a working token.
 *
 * The second is what matters. The first is a path check and a path check can
 * be bypassed by a bug; AAD cannot be bypassed by a bug, only by the key.
 *
 * ── What never happens here ──────────────────────────────────────
 *
 * No token, refresh token, ciphertext or key is ever put in an error, a log
 * line or a returned reference. `IntegrationCredentialReference` is by
 * contract "never a token or secret value", and `keyId` is a document id.
 */
import { createHash } from 'node:crypto';
import {
  decryptField,
  encryptField,
  fieldPurpose,
  isEncryptedField,
  type EncryptedField,
  type FieldEncryptionOptions,
} from '../../../security/fieldEncryption';
import { PROVIDER_CREDENTIALS, docIdForKey, userSubDoc } from '../../../storage/paths';
import type { StorageAdapter } from '../../../storage/storageAdapter';
import { requireLiveAccount } from '../../../account/accountLiveness';
import type { ProviderCredentialVault, ProviderOAuthTokenSet } from '../providerRuntime';
import type {
  ContextProviderKind,
  IntegrationCredentialReference,
} from '../../../../src/contracts/v1/integrationConnectionContracts';

/** Names the store in the reference. Not a secret, and not a key name. */
export const ENCRYPTED_VAULT_NAME = 'firestore-envelope-v1';

/**
 * The `purpose` half of the AAD.
 *
 * Distinct per provider, so a token stored for Google cannot be read back
 * through a path asking for Microsoft's — the same separation `fieldPurpose`
 * gives `ics-url` against `google-refresh-token`.
 */
export function credentialPurpose(provider: ContextProviderKind, keyId: string): string {
  // No ':' — `fieldPurpose` reserves it as the AAD separator.
  return fieldPurpose(`provider-oauth-token-${provider}`, keyId);
}

/**
 * The document id for a provider's credential.
 *
 * The vault is handed a token set *before* the connection record exists — the
 * reference it returns is what the upsert then stores — so the key cannot be a
 * connection id. It is derived from the provider instead, which also states
 * the rule that one account holds one grant per provider: connecting Google
 * again replaces the token rather than leaving an orphaned second one that
 * nothing would ever revoke.
 */
export function credentialKeyId(provider: ContextProviderKind): string {
  return docIdForKey(`provider-oauth:${provider}`);
}

/**
 * Which stored credential a reference came from (#800), by object identity.
 *
 * A refused OAuth completion that cannot delete the credential it just stored
 * records that deletion for later, and the later delete must take *that*
 * credential and no other: the document is keyed per provider, so by then it
 * may hold a newer one. The fingerprint is kept beside the reference rather
 * than in it, because the reference is a persisted contract
 * (`IntegrationCredentialReference`) that holds no such field.
 */
const storedFingerprints = new WeakMap<IntegrationCredentialReference, string>();

/** A digest of the wrapped data key: unique per stored value, not a secret, not reversible. */
export function credentialFingerprint(token: EncryptedField): string {
  return createHash('sha256').update(token.wrappedDek).digest('base64url');
}

/** The fingerprint of the credential `storeOAuthTokenSet` returned this reference for, if it did. */
export function storedCredentialFingerprint(reference: IntegrationCredentialReference): string | null {
  return storedFingerprints.get(reference) ?? null;
}

/** What is written. The secret half is entirely inside `token`. */
interface StoredCredentialDocument {
  readonly version: 1;
  readonly provider: ContextProviderKind;
  readonly token: EncryptedField;
  readonly updatedAt: string;
}

export class EncryptedProviderCredentialVault implements ProviderCredentialVault {
  constructor(
    private readonly uid: string,
    private readonly storage: StorageAdapter,
    private readonly options: FieldEncryptionOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  private path(keyId: string): string {
    // `userSubDoc` validates the uid and the document id, so a caller cannot
    // traverse out of this account's tree with a crafted connection id.
    return userSubDoc(this.uid, PROVIDER_CREDENTIALS, keyId);
  }

  async storeOAuthTokenSet(input: {
    readonly scopeId: string;
    readonly provider: ContextProviderKind;
    readonly tokenSet: ProviderOAuthTokenSet;
  }): Promise<IntegrationCredentialReference> {
    // The scope is the account. A vault built for one uid storing another's
    // token would defeat both bindings at once, so it is refused outright.
    if (input.scopeId !== this.uid) {
      throw new Error('credential scope does not match the vault account');
    }
    const keyId = credentialKeyId(input.provider);
    const purpose = credentialPurpose(input.provider, keyId);
    // `encryptField` builds the AAD from the uid and purpose itself, so the
    // binding cannot be forgotten at a call site.
    const token = await encryptField(this.uid, purpose, JSON.stringify(input.tokenSet), this.options);
    const document: StoredCredentialDocument = {
      version: 1,
      provider: input.provider,
      token,
      updatedAt: this.now().toISOString(),
    };
    // The account deletion fence (#772), in the transaction that stores the
    // secret: under a deleted account nothing is written at all, so a refusal
    // can never leave half a credential behind. The KMS round trip above stays
    // outside, so the transaction body is pure and safe to retry.
    await this.storage.runTransaction(async (tx) => {
      await requireLiveAccount(tx, this.uid);
      tx.set(this.path(keyId), document);
    });
    const reference: IntegrationCredentialReference = Object.freeze({
      vault: ENCRYPTED_VAULT_NAME,
      keyId,
      // The KMS key version the DEK was wrapped under, so a rotation is
      // visible in the record without the record holding key material.
      version: token.kmsKeyVersion ?? null,
    });
    storedFingerprints.set(reference, credentialFingerprint(token));
    return reference;
  }

  async loadOAuthTokenSet(
    reference: IntegrationCredentialReference,
  ): Promise<ProviderOAuthTokenSet | null> {
    if (reference.vault !== ENCRYPTED_VAULT_NAME) return null;
    const stored = await this.storage.get<StoredCredentialDocument>(this.path(reference.keyId));
    if (!stored || !isEncryptedField(stored.token)) return null;
    const purpose = credentialPurpose(stored.provider, reference.keyId);
    // Decryption under the wrong uid fails here rather than returning someone
    // else's secret: that is the AAD doing its job, not a check this file made.
    const plaintext = await decryptField(this.uid, purpose, stored.token, this.options);
    try {
      return Object.freeze(JSON.parse(plaintext) as ProviderOAuthTokenSet);
    } catch {
      // A parse failure must not echo the plaintext it failed on.
      throw new Error('stored credential is not a readable token set');
    }
  }

  async delete(reference: IntegrationCredentialReference): Promise<void> {
    if (reference.vault !== ENCRYPTED_VAULT_NAME) return;
    await this.storage.delete(this.path(reference.keyId));
  }
}
