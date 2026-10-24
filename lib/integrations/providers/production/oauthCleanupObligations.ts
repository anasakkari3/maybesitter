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
 * Only what the retry needs. A credential deletion needs the account, the
 * vault reference and the fingerprint of the exact credential it owes; a
 * revocation needs the tokens the provider's revoke call takes. Both are
 * sealed with `encryptField` — the same KMS envelope the vault uses for
 * refresh tokens — with the AAD bound to the obligation's random id and its
 * kind. The plaintext document holds a kind, a provider, timestamps, an
 * attempt count and, for a revocation, `accountKey`: the deletion pepper's
 * HMAC of the provider account id (`pepperedSubjectHashes`), which names
 * nobody without the pepper. Nothing here is ever logged, and no error raised
 * here carries a token, a uid or an account id.
 *
 * ── Why a revocation carries the account key ─────────────────────
 *
 * Google revokes the whole authorization for one Google account and this
 * client, not one token (`googleConnectService.ts`, "Nothing is revoked on a
 * re-consent"). A revocation still owed for account G2 would, once retried,
 * also kill any connection to G2 made since — the person who picked G2 by
 * mistake, disconnected G1 and connected G2 as told, or another MaybeSitter
 * account connecting G2. So a successful connect of an account clears every
 * revocation pending for it (`clearGrantRevocations`), whichever uid connects:
 * the grant that obligation meant to withdraw is, from then on, a grant a
 * connection holds, and disconnect and account deletion can reach it.
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
import { credentialFingerprint, ENCRYPTED_VAULT_NAME, storedCredentialFingerprint } from './encryptedCredentialVault';
import { pepperedSubjectHashes, storageMayHoldSharedTombstones } from '../../../account/deletionTombstone';
import { connectionIdFor } from './storedConnectionStore';

export type OAuthCleanupKind = 'credential_delete' | 'grant_revoke';

/** The stored document. Everything identifying or secret is inside `sealed`. */
export interface OAuthCleanupObligationDocument {
  readonly version: 1;
  readonly kind: OAuthCleanupKind;
  readonly provider: ContextProviderKind;
  readonly sealed: EncryptedField;
  /**
   * `grant_revoke` only: the pepper's HMAC of the provider account the grant
   * belongs to, or null when it is not known (no account id was read, or no
   * pepper exists on unshared storage). Lets a connect of that account clear
   * the obligation.
   */
  readonly accountKey?: string | null;
  readonly createdAt: string;
  /** The last write: the recording, or the last failed retry. Retries go oldest first. */
  readonly updatedAt: string;
  /** Failed retries so far. */
  readonly attempts: number;
}

interface CredentialDeletePayload {
  readonly uid: string;
  readonly credentialRef: IntegrationCredentialReference;
  /** `credentialFingerprint` of the exact credential owed; only that one is deleted. */
  readonly fingerprint: string;
}

/** Only the two token strings a revoke call can use; no scopes, no expiry. */
interface GrantRevokePayload {
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

export function oauthCleanupObligationPath(id: string): string {
  return `${OAUTH_CLEANUP_OBLIGATIONS}/${requireDocId(id)}`;
}

/**
 * Every key a provider account can be filed under: one per configured pepper,
 * current first. Empty where unshared storage has no pepper. The subject is
 * namespaced per provider, so it can never equal a uid's subject hash.
 */
export function providerAccountKeys(provider: ContextProviderKind, providerAccountId: string): string[] {
  const subject = `${provider}_${providerAccountId}`;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(subject)) return [];
  return pepperedSubjectHashes(subject, { sharedStorage: storageMayHoldSharedTombstones() });
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
    // Bound to the exact credential the vault stored for this reference. A
    // reference this process's vault did not hand out cannot be bound, so it
    // is refused rather than recorded as "whatever is there later".
    const fingerprint = storedCredentialFingerprint(input.credentialRef);
    if (!fingerprint) throw new Error('oauth cleanup cannot identify the credential it would delete');
    const payload: CredentialDeletePayload = {
      uid: input.scopeId,
      credentialRef: {
        vault: input.credentialRef.vault,
        keyId: input.credentialRef.keyId,
        version: input.credentialRef.version,
      },
      fingerprint,
    };
    await this.record('credential_delete', input.provider, payload, null);
  }

  async recordGrantRevocation(input: {
    readonly provider: ContextProviderKind;
    readonly tokenSet: ProviderOAuthTokenSet;
    readonly providerAccountId?: string | null;
  }): Promise<void> {
    const payload: GrantRevokePayload = {
      accessToken: input.tokenSet.accessToken,
      refreshToken: input.tokenSet.refreshToken,
    };
    const accountKey = input.providerAccountId ? providerAccountKeys(input.provider, input.providerAccountId)[0] ?? null : null;
    await this.record('grant_revoke', input.provider, payload, accountKey);
  }

  /**
   * A connection of this provider account was just stored: every revocation
   * still owed for it is dropped, because revoking now would withdraw the
   * authorization that connection holds. Returns how many were cleared; throws
   * when the clear could not be done, so the caller does not report a
   * connection a nightly retry would then kill.
   */
  async clearGrantRevocations(provider: ContextProviderKind, providerAccountId: string): Promise<number> {
    const keys = providerAccountKeys(provider, providerAccountId);
    if (keys.length === 0) return 0;
    const owed = await this.storage.list<OAuthCleanupObligationDocument>(OAUTH_CLEANUP_OBLIGATIONS, {
      where: [['accountKey', 'in', keys]],
    });
    let cleared = 0;
    for (const { id, data } of owed) {
      if (data.kind !== 'grant_revoke' || data.provider !== provider) continue;
      await this.storage.delete(oauthCleanupObligationPath(id));
      cleared += 1;
    }
    return cleared;
  }

  private async record(
    kind: OAuthCleanupKind,
    provider: ContextProviderKind,
    payload: object,
    accountKey: string | null,
  ): Promise<void> {
    const id = randomUUID();
    const sealed = await encryptField(id, sealPurpose(kind, provider), JSON.stringify(payload), this.encryption);
    const at = this.now().toISOString();
    const document: OAuthCleanupObligationDocument = {
      version: 1,
      kind,
      provider,
      sealed,
      ...(kind === 'grant_revoke' ? { accountKey } : {}),
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
        // A connect of this account may have cleared it since it was listed;
        // revoking then would withdraw the grant that connection holds.
        if (!(await storage.get(path))) {
          cleared += 1;
          continue;
        }
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
 * document may hold a *different* credential: the person connected again, or a
 * concurrent completion stored its own. So only the exact credential the
 * obligation was recorded for is deleted — the one whose wrapped key matches
 * the recorded fingerprint — and even that one is left alone when a live
 * connection record points at it (a connection write that landed but answered
 * with an error): it then belongs to a record that disconnect and account
 * deletion can reach. A swept account has nothing left to delete.
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
    const stored = await tx.get<{ readonly token?: unknown }>(credentialPath);
    const owned = connection !== null
      && connection.state !== 'revoked'
      && connection.state !== 'not_connected'
      && connection.credentialRef?.vault === ref.vault
      && connection.credentialRef?.keyId === ref.keyId;
    const same = stored !== null && isEncryptedField(stored.token) && credentialFingerprint(stored.token) === payload.fingerprint;
    if (same && !owned) tx.delete(credentialPath);
    tx.delete(obligationPath);
  });
}
