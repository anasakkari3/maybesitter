/**
 * OAuth cleanup that must still happen, kept until it does (#800).
 *
 * ── The gap this closes ──────────────────────────────────────────
 *
 * With the #772 writer fences an OAuth completion can be refused after the
 * provider already issued a grant: the account was deleted between the
 * credential write and the connection write, or while Google was asking. The
 * completion then takes back what it holds — deletes the credential it stored,
 * revokes the grant Google just issued. Both used to be best effort
 * (`.catch(() => undefined)`), and a failure left a credential, or a live
 * Google authorization, with no connection record through which a disconnect
 * or account deletion could ever retry it.
 *
 * So a failed cleanup is written down here instead of swallowed, and the
 * nightly maintenance job (`runMaintenance`, next to `resumeStalledDeletions`)
 * retries every obligation until it succeeds, then deletes it. Cloud Scheduler
 * calls that job; there is no worker, and this adds none.
 *
 * ── Why a collection of its own, outside the tree ────────────────
 *
 * The obligation has to survive the account deletion that is often the reason
 * it exists, so it cannot live under `users/{uid}`, which the deletion sweeps.
 * Attaching it to the deletion job record would not do either: the same
 * cleanup is owed when no deletion is involved (a failed connection write, a
 * wrong account picked), and a finished deletion job is no longer resumed and
 * expires on a TTL. `oauthCleanupObligations` has no TTL on purpose — an
 * obligation that silently expired would be the swallowed error again.
 *
 * ── What is kept, and how ────────────────────────────────────────
 *
 * Only what the retry needs. A credential deletion needs the account and the
 * vault reference; a revocation needs the tokens the provider's revoke call
 * takes. Both are sealed with `encryptField` — the same KMS envelope the vault
 * uses for refresh tokens — with the AAD bound to the obligation's random id
 * and its kind, so the plaintext document names nobody and holds no secret:
 * a kind, a provider, timestamps and an attempt count. Nothing here is ever
 * logged, and no error raised here carries a token or a uid.
 */
import { randomUUID } from 'node:crypto';
import {
  decryptField,
  encryptField,
  fieldPurpose,
  isEncryptedField,
  type EncryptedField,
  type FieldEncryptionOptions,
} from '../../../security/fieldEncryption';
import {
  OAUTH_CLEANUP_OBLIGATIONS,
  PROVIDER_CONNECTIONS,
  PROVIDER_CREDENTIALS,
  requireDocId,
  userSubDoc,
} from '../../../storage/paths';
import { getStorage } from '../../../storage';
import type { StorageAdapter } from '../../../storage/storageAdapter';
import type {
  ContextProviderKind,
  IntegrationConnectionRecord,
  IntegrationCredentialReference,
} from '../../../../src/contracts/v1/integrationConnectionContracts';
import type { ProviderOAuthCleanupObligations } from '../providerOAuthLifecycle';
import type { ProviderOAuthTokenSet } from '../providerRuntime';
import { ENCRYPTED_VAULT_NAME } from './encryptedCredentialVault';
import { connectionIdFor } from './storedConnectionStore';

export type OAuthCleanupKind = 'credential_delete' | 'grant_revoke';

/** The stored document. Everything identifying or secret is inside `sealed`. */
export interface OAuthCleanupObligationDocument {
  readonly version: 1;
  readonly kind: OAuthCleanupKind;
  readonly provider: ContextProviderKind;
  readonly sealed: EncryptedField;
  readonly createdAt: string;
  /** The last write: the recording, or the last failed retry. Retries go oldest first. */
  readonly updatedAt: string;
  /** Failed retries so far. */
  readonly attempts: number;
}

interface CredentialDeletePayload {
  readonly uid: string;
  readonly credentialRef: IntegrationCredentialReference;
}

/** Only the two token strings a revoke call can use; no scopes, no expiry. */
interface GrantRevokePayload {
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

export function oauthCleanupObligationPath(id: string): string {
  return `${OAUTH_CLEANUP_OBLIGATIONS}/${requireDocId(id)}`;
}

/** The AAD purpose: one per kind and provider; the subject half is the obligation id. */
function sealPurpose(kind: OAuthCleanupKind, provider: ContextProviderKind): string {
  return fieldPurpose(`oauth-cleanup-${kind}`, provider);
}

/**
 * The production `ProviderOAuthCleanupObligations`.
 *
 * Each record call resolves only after the sealed document is stored; a KMS
 * or storage failure throws, and the caller answers that as a failure rather
 * than as a cleanup that happened.
 */
export class StoredOAuthCleanupObligations implements ProviderOAuthCleanupObligations {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly encryption: FieldEncryptionOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recordCredentialDeletion(input: {
    readonly scopeId: string;
    readonly provider: ContextProviderKind;
    readonly credentialRef: IntegrationCredentialReference;
  }): Promise<void> {
    const payload: CredentialDeletePayload = {
      uid: input.scopeId,
      credentialRef: {
        vault: input.credentialRef.vault,
        keyId: input.credentialRef.keyId,
        version: input.credentialRef.version,
      },
    };
    await this.record('credential_delete', input.provider, payload);
  }

  async recordGrantRevocation(input: {
    readonly provider: ContextProviderKind;
    readonly tokenSet: ProviderOAuthTokenSet;
  }): Promise<void> {
    const payload: GrantRevokePayload = {
      accessToken: input.tokenSet.accessToken,
      refreshToken: input.tokenSet.refreshToken,
    };
    await this.record('grant_revoke', input.provider, payload);
  }

  private async record(kind: OAuthCleanupKind, provider: ContextProviderKind, payload: object): Promise<void> {
    const id = randomUUID();
    const sealed = await encryptField(id, sealPurpose(kind, provider), JSON.stringify(payload), this.encryption);
    const at = this.now().toISOString();
    const document: OAuthCleanupObligationDocument = {
      version: 1,
      kind,
      provider,
      sealed,
      createdAt: at,
      updatedAt: at,
      attempts: 0,
    };
    await this.storage.set(oauthCleanupObligationPath(id), document);
  }
}

export interface RetryOAuthCleanupOptions {
  readonly storage?: StorageAdapter;
  readonly encryption?: FieldEncryptionOptions;
  readonly now?: Date;
  /** How many obligations one run takes, least recently tried first. */
  readonly limit?: number;
  /**
   * Revokes a grant at its provider. Throws when it cannot — including when
   * the provider is no longer configured — and the obligation is kept.
   */
  readonly revoke: (provider: ContextProviderKind, tokenSet: ProviderOAuthTokenSet) => Promise<void>;
}

export interface RetryOAuthCleanupTotals {
  readonly attempted: number;
  /** Done, and the obligation deleted. */
  readonly cleared: number;
  /** Still owed; kept for the next run. */
  readonly failed: number;
}

export const OAUTH_CLEANUP_BATCH = 100;

/**
 * Retries every recorded OAuth cleanup until it lands (#800).
 *
 * An obligation is deleted only after its cleanup succeeded; any failure —
 * KMS, storage, the provider — keeps it, with its attempt count raised, for
 * the next run. Both cleanups are idempotent (a provider answers an already
 * revoked token as done, a missing credential is nothing to delete), so two
 * overlapping runs, or a run after a clear that did not land, do no harm.
 */
export async function retryOAuthCleanupObligations(options: RetryOAuthCleanupOptions): Promise<RetryOAuthCleanupTotals> {
  const storage = options.storage ?? getStorage();
  const encryption = options.encryption ?? {};
  const now = options.now ?? new Date();
  const pending = await storage.list<OAuthCleanupObligationDocument>(OAUTH_CLEANUP_OBLIGATIONS, {
    orderBy: { field: 'updatedAt', direction: 'asc' },
    limit: options.limit ?? OAUTH_CLEANUP_BATCH,
  });

  let cleared = 0;
  let failed = 0;
  for (const { id, data } of pending) {
    const path = oauthCleanupObligationPath(id);
    try {
      if (!isEncryptedField(data.sealed)) throw new Error('oauth cleanup obligation is not sealed');
      const plaintext = await decryptField(id, sealPurpose(data.kind, data.provider), data.sealed, encryption);
      if (data.kind === 'credential_delete') {
        await deleteCredential(storage, path, data, JSON.parse(plaintext) as CredentialDeletePayload);
      } else if (data.kind === 'grant_revoke') {
        const handle = JSON.parse(plaintext) as GrantRevokePayload;
        await options.revoke(data.provider, {
          accessToken: handle.accessToken,
          refreshToken: handle.refreshToken,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          grantedScopes: [],
        });
        await storage.delete(path);
      } else {
        throw new Error('unknown oauth cleanup obligation kind');
      }
      cleared += 1;
    } catch {
      failed += 1;
      // Kept, and moved to the back of the queue. In a transaction, so a run
      // that failed cannot bring back an obligation another run just cleared.
      try {
        await storage.runTransaction(async (tx) => {
          const current = await tx.get<OAuthCleanupObligationDocument>(path);
          if (!current) return;
          tx.set<OAuthCleanupObligationDocument>(path, {
            ...current,
            attempts: (current.attempts ?? 0) + 1,
            updatedAt: now.toISOString(),
          });
        });
      } catch {
        // Bookkeeping only: the obligation itself is still stored either way,
        // and `failed` already reports it.
      }
    }
  }
  return { attempted: pending.length, cleared, failed };
}

/**
 * Deletes the credential the refused completion left behind, and the
 * obligation with it, in one transaction.
 *
 * The vault keys a credential per provider, so by the time this runs the same
 * document may hold a *newer* credential: the person connected again, and that
 * connection is live. Deleting it would break a working connection. So the
 * credential is left alone when a live connection record points at it, or when
 * it was written after the obligation was — either way it now belongs to a
 * record that disconnect and account deletion can reach. A swept account has
 * neither, and nothing left to delete.
 */
async function deleteCredential(
  storage: StorageAdapter,
  obligationPath: string,
  obligation: OAuthCleanupObligationDocument,
  payload: CredentialDeletePayload,
): Promise<void> {
  const ref = payload.credentialRef;
  // The only vault the production completion stores into; anything else is
  // not something this job knows how to delete, and stays owed.
  if (ref.vault !== ENCRYPTED_VAULT_NAME) throw new Error('oauth cleanup names a vault this job cannot reach');
  const credentialPath = userSubDoc(payload.uid, PROVIDER_CREDENTIALS, ref.keyId);
  const connectionPath = userSubDoc(payload.uid, PROVIDER_CONNECTIONS, connectionIdFor(obligation.provider));
  await storage.runTransaction(async (tx) => {
    const connection = await tx.get<IntegrationConnectionRecord>(connectionPath);
    const stored = await tx.get<{ readonly updatedAt?: unknown }>(credentialPath);
    const owned = connection !== null
      && connection.state !== 'revoked'
      && connection.state !== 'not_connected'
      && connection.credentialRef?.vault === ref.vault
      && connection.credentialRef?.keyId === ref.keyId;
    const newer = typeof stored?.updatedAt === 'string' && stored.updatedAt > obligation.createdAt;
    if (stored && !owned && !newer) tx.delete(credentialPath);
    tx.delete(obligationPath);
  });
}
