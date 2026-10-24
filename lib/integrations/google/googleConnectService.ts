/**
 * Connecting, reading through, and disconnecting one Google account (CL6a;
 * started as the Gmail Phase B connect flow on `feat/google-oauth-connect`).
 *
 * Everything this needs already existed and none of it is re-implemented here:
 * `beginProviderOAuth` / `completeProviderOAuth` own the state and PKCE
 * lifecycle, `StoredProviderOAuthStateStore` owns the state at rest (SHA-256
 * document id, encrypted verifier, transactional consume),
 * `EncryptedProviderCredentialVault` owns the tokens (KMS envelope, uid-bound
 * AAD), `StoredIntegrationConnectionStore` owns the record (one per account per
 * provider), `loadProviderAccessToken` decides when to refresh, and
 * `createGoogleOAuthClient` owns the HTTP. This file is the wiring, plus the
 * decisions that are specific to Google for this product.
 *
 * ── Why the exchange is an authenticated POST, not the browser GET ──
 *
 * Google redirects the **browser** to the redirect URI, and a browser redirect
 * carries no Firebase bearer token. A route that exchanged `?code=&state=`
 * from that redirect would have no authenticated uid, and would have to take
 * the account from the state record itself — which would make
 * `completeProviderOAuth`'s `state.scopeId !== input.scopeId` check compare a
 * value against itself and always pass. Replay protection would survive;
 * ownership protection would not.
 *
 * So the redirect URI (`/api/oauth/google/callback`) only forwards `code` and
 * `state` to the app's own scheme, the app's auth session hands them back, and
 * the app POSTs them to `/api/mobile/integrations/google/callback` with its own
 * bearer. A code intercepted on the way is useless to anyone else: the
 * verifier never left the server, and the state only completes for the uid
 * that started it.
 *
 * ── Why the redirect URI is never echoed ─────────────────────────
 *
 * It is resolved when the flow *begins*, stored in the state record, and read
 * back from that record for the exchange. Nothing the callback sends can
 * influence it.
 *
 * ── Statuses: never 401 ──────────────────────────────────────────
 *
 * The app reads a 401 from `/api/mobile/**` as *its own* session having
 * expired: it refreshes once and then signs the person out. A dead Google
 * grant, a replayed state or a mismatched account is none of that, so every
 * refusal here is a 4xx other than 401, with a closed `reason` the app maps to
 * words (`GOOGLE_REFUSAL_STATUS`). The Phase B draft answered a replayed state
 * and a dead grant with 401, which would have signed people out of the app for
 * pressing Back in Google's consent screen.
 */
import { randomUUID } from 'node:crypto';
import { AccountUnavailableError } from '../../account/accountLiveness';
import {
  beginProviderOAuth,
  completeProviderOAuth,
  disconnectProviderOAuth,
  ProviderOAuthCleanupError,
  ProviderOAuthError,
  revokeOrRecordGrant,
  type ProviderOAuthClient,
} from '../providers/providerOAuthLifecycle';
import type { ProviderOAuthTokenSet } from '../providers/providerRuntime';
import { StoredProviderOAuthStateStore } from '../providers/production/storedOAuthStateStore';
import { StoredIntegrationConnectionStore, connectionIdFor } from '../providers/production/storedConnectionStore';
import { EncryptedProviderCredentialVault } from '../providers/production/encryptedCredentialVault';
import { StoredOAuthCleanupObligations } from '../providers/production/oauthCleanupObligations';
import {
  loadProviderAccessToken,
  ProviderAccessTokenError,
} from '../providers/production/providerAccessToken';
import { refreshProviderAccessToken } from '../providers/production/refreshProviderAccessToken';
import { FieldEncryptionError } from '../../security/fieldEncryption';
import {
  createGoogleOAuthClient,
  GoogleAccountMismatchError,
  GoogleOAuthError,
  GOOGLE_AUTHORIZATION_ENDPOINT,
} from './googleOAuthClient';
import { deleteBusySource, type BusySourceReplacementFence } from '../../calendar/busyBlocks';
import { getAiConsent } from '../../consents/aiConsentService';
import {
  featuresGranted,
  GOOGLE_APP_RETURN_URL,
  GOOGLE_BUSY_SOURCE_ID,
  GOOGLE_FEATURE_SCOPES,
  GOOGLE_FEATURES,
  GOOGLE_IDENTITY_SCOPES,
  resolveGoogleConfig,
  type GoogleFeature,
  type GoogleOAuthConfig,
} from './googleConfig';
import type { GoogleRuntime } from './googleRuntime';
import type {
  IntegrationCapability,
  IntegrationConnectionRecord,
} from '../../../src/contracts/v1/integrationConnectionContracts';
import {
  BUSY_SOURCE_FENCES,
  INTELLIGENCE_GMAIL_SCANS,
  INTELLIGENCE_MONITORS,
  docIdForKey,
  userCol,
  userSubDoc,
} from '../../storage/paths';

function googleBusyFencePath(uid: string): string {
  return userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID));
}

async function advanceGoogleBusyFence(uid: string, runtime: GoogleRuntime): Promise<number> {
  return runtime.storage.runTransaction(async (tx) => {
    const prior = await tx.get<BusySourceReplacementFence>(googleBusyFencePath(uid));
    const generation = (prior?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new GoogleConnectError('google_unavailable');
    const { replace: _replace, ...withoutReplace } = prior ?? { generation: 0 };
    tx.set<BusySourceReplacementFence>(googleBusyFencePath(uid), { ...withoutReplace, generation });
    return generation;
  });
}

export const GOOGLE_PROVIDER = 'google' as const;

/** The capability each feature records on the connection. */
const FEATURE_CAPABILITY: Readonly<Record<GoogleFeature, IntegrationCapability>> = Object.freeze({
  calendar: 'calendar_busy',
  gmail: 'mail_read',
  drive: 'file_read',
});

/** Every refusal this chain can give, and the one status each is answered with. */
export const GOOGLE_REFUSAL_STATUS = Object.freeze({
  provider_not_configured: 503,
  google_not_connected: 409,
  google_reauth_required: 409,
  google_feature_not_granted: 409,
  google_account_mismatch: 409,
  google_permission_not_granted: 409,
  google_access_denied: 400,
  google_state_invalid: 400,
  google_unavailable: 502,
  google_picker_unavailable: 503,
  google_file_unsupported: 422,
  google_file_too_large: 422,
  /**
   * Reading mail or a document is a model call, and the person has not agreed
   * to those. Refused before a single message or byte is fetched: reading
   * somebody's mail to then say "nothing found" would be both a wasted read
   * and an untrue answer.
   */
  ai_consent_required: 409,
} as const);

export type GoogleRefusalReason = keyof typeof GOOGLE_REFUSAL_STATUS;

export class GoogleConnectError extends Error {
  readonly status: number;
  constructor(readonly reason: GoogleRefusalReason) {
    // Fixed per reason. Never a code, a verifier, a token or Google's prose.
    super(`google: ${reason}`);
    this.name = 'GoogleConnectError';
    this.status = GOOGLE_REFUSAL_STATUS[reason];
  }
}

/** One JSON shape for every refusal: `error` and `reason` are the same closed code. */
export function googleErrorResponse(error: unknown): Response {
  const refusal = error instanceof GoogleConnectError ? error : asConnectError(error);
  return Response.json(
    { success: false, error: refusal.reason, reason: refusal.reason },
    { status: refusal.status },
  );
}

/** Maps every error this chain can raise onto one closed reason. */
export function asConnectError(error: unknown): GoogleConnectError {
  if (error instanceof GoogleConnectError) return error;
  if (error instanceof GoogleAccountMismatchError) return new GoogleConnectError('google_account_mismatch');
  if (error instanceof FieldEncryptionError && error.code === 'not_configured') {
    return new GoogleConnectError('provider_not_configured');
  }
  if (error instanceof ProviderAccessTokenError) {
    if (error.code === 'connection_missing' || error.code === 'token_revoked' || error.code === 'scope_mismatch') {
      return new GoogleConnectError('google_not_connected');
    }
    return new GoogleConnectError('google_reauth_required');
  }
  if (error instanceof GoogleOAuthError) {
    // `httpStatus` is canonical: the client already turned the token
    // endpoint's 400 `invalid_grant` into 401.
    if (error.httpStatus === 401) return new GoogleConnectError('google_reauth_required');
    if (error.httpStatus === 403) return new GoogleConnectError('google_permission_not_granted');
    return new GoogleConnectError('google_unavailable');
  }
  if (error instanceof ProviderOAuthError) {
    if (error.code === 'invalid_or_replayed_state' || error.code === 'state_scope_mismatch'
      || error.code === 'invalid_request' || error.code === 'provider_mismatch') {
      return new GoogleConnectError('google_state_invalid');
    }
    // The person unticked the permission on Google's granular consent screen.
    if (error.code === 'scope_mismatch') return new GoogleConnectError('google_permission_not_granted');
    if (error.code === 'malformed_provider_identity') return new GoogleConnectError('google_account_mismatch');
    return new GoogleConnectError('google_unavailable');
  }
  // Anything unrecognised refuses rather than admits, and says nothing about
  // itself: an unrecognised failure is exactly where a raw provider message
  // would otherwise escape.
  return new GoogleConnectError('google_unavailable');
}

async function requireConfig(runtime: GoogleRuntime): Promise<GoogleOAuthConfig> {
  const resolved = await resolveGoogleConfig({ env: runtime.env, secrets: runtime.secrets });
  if (!resolved.configured) throw new GoogleConnectError('provider_not_configured');
  return resolved.config;
}

function stores(uid: string, runtime: GoogleRuntime) {
  return {
    states: new StoredProviderOAuthStateStore(uid, runtime.storage, runtime.encryption),
    connections: new StoredIntegrationConnectionStore(uid, runtime.storage),
    vault: new EncryptedProviderCredentialVault(uid, runtime.storage, runtime.encryption, runtime.now),
    // Outside the account's tree (#800): what a refused completion could not
    // clean up has to outlive the deletion that refused it.
    cleanup: new StoredOAuthCleanupObligations(runtime.storage, runtime.encryption, runtime.now),
  };
}

/**
 * Revokes a Google grant an OAuth cleanup obligation still owes (#800), for the
 * maintenance job. Throws when Google is not configured or refuses, so the
 * obligation is kept for the next run.
 */
export async function revokeGoogleGrantForCleanup(
  tokenSet: ProviderOAuthTokenSet,
  runtime: GoogleRuntime,
): Promise<void> {
  const config = await requireConfig(runtime);
  await clientFor(config, runtime).revoke(tokenSet);
}

function clientFor(
  config: GoogleOAuthConfig,
  runtime: GoogleRuntime,
  requireAccountId?: string,
  observeAccountId?: (sub: string) => void,
) {
  return createGoogleOAuthClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetchImpl: runtime.fetchImpl,
    now: runtime.now,
    ...(requireAccountId === undefined ? {} : { requireAccountId }),
    ...(observeAccountId === undefined ? {} : { observeAccountId }),
  });
}

async function currentConnection(uid: string, runtime: GoogleRuntime): Promise<IntegrationConnectionRecord | null> {
  return stores(uid, runtime).connections.get(connectionIdFor(GOOGLE_PROVIDER));
}

/**
 * Whether this account still holds a Google grant, read from the record alone
 * — no config, no KMS, no call to Google — so account deletion can tell a
 * grant it cannot revoke from no grant at all.
 */
export async function hasLiveGoogleConnection(uid: string, runtime: GoogleRuntime): Promise<boolean> {
  return isLive(await new StoredIntegrationConnectionStore(uid, runtime.storage).get(connectionIdFor(GOOGLE_PROVIDER)));
}

/** A connection that still holds a grant: anything but gone or never made. */
function isLive(record: IntegrationConnectionRecord | null): record is IntegrationConnectionRecord {
  return record !== null && record.state !== 'revoked' && record.state !== 'not_connected'
    && Boolean(record.credentialRef);
}

/* ── Status ────────────────────────────────────────────────────── */

export type GoogleConnectionStatus = 'not_configured' | 'not_connected' | 'connected' | 'needs_reauth';

export interface GoogleStatus {
  readonly status: GoogleConnectionStatus;
  /** The address the person connected, for the row. Never a token. */
  readonly accountEmail: string | null;
  readonly features: Readonly<Record<GoogleFeature, boolean>>;
  /** Drive also needs the Picker key; without it the Drive row says so. */
  readonly pickerAvailable: boolean;
  readonly connectedAt: string | null;
}

const NO_FEATURES = Object.freeze({ calendar: false, gmail: false, drive: false });

/**
 * What the three rows show.
 *
 * `not_configured` outranks everything, including a stored connection: with
 * the client secret gone nothing can refresh or revoke, and a row saying
 * "connected" would be a promise the server cannot keep.
 */
export async function getGoogleStatus(uid: string, runtime: GoogleRuntime): Promise<GoogleStatus> {
  const resolved = await resolveGoogleConfig({ env: runtime.env, secrets: runtime.secrets });
  if (!resolved.configured) {
    return { status: 'not_configured', accountEmail: null, features: NO_FEATURES, pickerAvailable: false, connectedAt: null };
  }
  const pickerAvailable = resolved.config.pickerApiKey !== null && resolved.config.appId !== null;
  const record = await currentConnection(uid, runtime);
  if (!isLive(record)) {
    return { status: 'not_connected', accountEmail: null, features: NO_FEATURES, pickerAvailable, connectedAt: null };
  }
  return {
    status: record.state === 'needs_reauth' ? 'needs_reauth' : 'connected',
    accountEmail: record.identity.displayName ?? null,
    features: featuresGranted(record.grantedScopes),
    pickerAvailable,
    connectedAt: record.connectedAt ?? null,
  };
}

/* ── Connect ───────────────────────────────────────────────────── */

export interface BeginGoogleConnectResult {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
  /** What the app's auth session waits for. Fixed; not an echo of anything sent. */
  readonly returnUrl: string;
}

/**
 * Starts an authorization for one feature.
 *
 * Asks for that feature's scope and the two identity scopes, never the other
 * features' scopes: `include_granted_scopes=true` on the endpoint carries what
 * was already granted forward, so turning Gmail on after Calendar does not
 * re-ask for Calendar and does not lose it. A reconnect («أعد الربط») asks for
 * every feature the lapsed grant held, because a dead refresh token takes all
 * of them with it.
 *
 * The `state` is not returned as its own field: it is already in the URL.
 */
export async function beginGoogleConnect(
  uid: string,
  feature: GoogleFeature,
  runtime: GoogleRuntime,
): Promise<BeginGoogleConnectResult> {
  const config = await requireConfig(runtime);
  try {
    const existing = await currentConnection(uid, runtime);
    const held = isLive(existing) ? featuresGranted(existing.grantedScopes) : NO_FEATURES;
    const reauth = isLive(existing) && existing.state === 'needs_reauth';
    const wanted: GoogleFeature[] = [feature];
    if (reauth) {
      for (const name of GOOGLE_FEATURES) if (held[name] && !wanted.includes(name)) wanted.push(name);
    }
    const capabilities: IntegrationCapability[] = isLive(existing) ? [...existing.capabilities] : [];
    for (const name of wanted) {
      if (!capabilities.includes(FEATURE_CAPABILITY[name])) capabilities.push(FEATURE_CAPABILITY[name]);
    }

    const begun = await beginProviderOAuth(
      stores(uid, runtime).states,
      {
        scopeId: uid,
        provider: GOOGLE_PROVIDER,
        capabilities,
        requestedScopes: [...GOOGLE_IDENTITY_SCOPES, ...wanted.map((name) => GOOGLE_FEATURE_SCOPES[name])],
        authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        now: runtime.now().toISOString(),
      },
      runtime.random,
    );
    return Object.freeze({
      authorizationUrl: begun.authorizationUrl,
      expiresAt: begun.expiresAt,
      returnUrl: GOOGLE_APP_RETURN_URL,
    });
  } catch (error) {
    // The account was deleted under this request (#772): answered as such.
    if (error instanceof AccountUnavailableError) throw error;
    throw asConnectError(error);
  }
}

export interface CompleteGoogleConnectInput {
  readonly code: string;
  readonly state: string;
}

/**
 * Finishes an authorization the app carried back from the redirect.
 *
 * `uid` comes from the verified Firebase token, never from the request body.
 * `completeProviderOAuth` then refuses a state whose `scopeId` is not this uid,
 * which is the check that stops a stolen code being redeemed into another
 * account.
 *
 * A live connection pins the Google account: adding Gmail to a grant made for
 * one account must not quietly swap in another. After a disconnect the pin is
 * gone, so the person can connect whichever account they like.
 *
 * ── Nothing is revoked on a re-consent of the same account (CL6a review C1) ──
 *
 * `prompt=consent` makes Google issue a new refresh token on every
 * authorization, and `include_granted_scopes=true` makes that token belong to
 * one *combined* authorization for this person and this client. Google's
 * revocation acts on the authorization, not on the token string: "If you
 * revoke a token that represents a combined authorization, access to all of
 * that authorization's scopes on behalf of the associated user are revoked
 * simultaneously" (G1, incremental authorization). The first draft revoked the
 * superseded refresh token after turning a second feature on, which at Google
 * would have killed the token just issued as well — the row would say
 * "connected" and the next read would answer `invalid_grant`.
 *
 * So the superseded token is simply dropped: the vault document is keyed per
 * provider and the new token set has already replaced it. Google retires old
 * refresh tokens for a client/user pair on its own once there are too many.
 * Revocation belongs to the two places where the person means "take it
 * away": disconnect and account deletion.
 *
 * ── A different Google account while one is connected ──────────
 *
 * Refused with `google_account_mismatch`, and nothing is stored: the pinned
 * account keeps working, and the person is told to disconnect first if they
 * really mean to switch. Switching silently would move busy time and mail
 * reading to an account the person may not have noticed they picked in
 * Google's account chooser. But the *other* account did consent, and Google
 * issued it a grant nobody now holds — one the person could never withdraw
 * from this app. That grant is a different authorization (different user), so
 * revoking it cannot touch the connected one, and it is revoked — or, when
 * Google refuses, recorded for the cleanup job to revoke later (#800).
 */
export async function completeGoogleConnect(
  uid: string,
  input: CompleteGoogleConnectInput,
  runtime: GoogleRuntime,
): Promise<GoogleStatus> {
  const config = await requireConfig(runtime);
  const { states, connections, vault, cleanup } = stores(uid, runtime);
  // The token set this exchange produced, held only for as long as this call
  // runs, so a grant for the wrong account can be withdrawn (see above).
  let issued: ProviderOAuthTokenSet | null = null;
  // The Google account that grant belongs to, read before the pin check, so a
  // revocation recorded for later can be cancelled by a connect of that same
  // account (#800). Never logged.
  let issuedAccountId: string | null = null;
  try {
    const existing = await currentConnection(uid, runtime);
    const pinned = isLive(existing) ? existing.identity.providerAccountId ?? undefined : undefined;
    const client = clientFor(config, runtime, pinned, (sub) => { issuedAccountId = sub; });
    const capturing: ProviderOAuthClient = {
      ...client,
      async exchangeAuthorizationCode(request) {
        issued = await client.exchangeAuthorizationCode(request);
        return issued;
      },
    };

    const connected = await completeProviderOAuth(states, vault, connections, capturing, {
      scopeId: uid,
      provider: GOOGLE_PROVIDER,
      state: input.state,
      code: input.code,
      now: runtime.now().toISOString(),
    }, cleanup);
    // This Google account now has a live connection. A revocation still owed
    // for it — from a refused completion, by this account or any other — would
    // withdraw the whole authorization this connection holds (Google revokes
    // per account and client), so it is cancelled here (#800). Only an
    // optimisation: the connection is already stored, so a failed clear must
    // not fail the connect, and the cleanup job will not revoke anyway while a
    // live connection holds the account (`liveConnectionHolds`).
    const accountId = connected.identity.providerAccountId;
    if (accountId) {
      try {
        await cleanup.clearGrantRevocations(GOOGLE_PROVIDER, accountId);
      } catch {
        // Left for the cleanup job, which drops it without revoking.
      }
    }
    return await getGoogleStatus(uid, runtime);
  } catch (error) {
    // The refusal the completion answered, even when its own credential
    // cleanup could not be recorded either (#800).
    const refusal = error instanceof ProviderOAuthCleanupError ? error.refusal : error;
    // Another person's authorization, never the connected one's: `loadIdentity`
    // refused it before anything was stored. Or the account was deleted while
    // Google was asking (#772): nothing was stored, and account deletion's own
    // revocation found no connection to revoke. Either way nobody here could
    // ever withdraw the grant just issued, so it is revoked now — and when
    // Google refuses, the revocation is recorded for the cleanup job, which
    // retries it until it lands, rather than dropped (#800).
    if (issued && (refusal instanceof GoogleAccountMismatchError || refusal instanceof AccountUnavailableError)) {
      try {
        await revokeOrRecordGrant(clientFor(config, runtime), issued, cleanup, issuedAccountId);
      } catch (cleanupError) {
        // Neither revoked nor recorded: answered as a failure, never as done.
        throw asConnectError(cleanupError);
      }
    }
    if (error instanceof AccountUnavailableError) throw error;
    throw asConnectError(error);
  } finally {
    issued = null;
    issuedAccountId = null;
  }
}

/**
 * Disconnect: revoke at Google, delete the credential, mark the record — in
 * that order, which `disconnectProviderOAuth` enforces — and then take the
 * Google busy time off the account.
 *
 * A revocation Google refuses leaves the credential in place and the
 * connection in `error`: deleting our only copy of a token Google still
 * honours would leave a live grant nobody can see or withdraw.
 */
export async function disconnectGoogle(
  uid: string,
  runtime: GoogleRuntime,
  options: {
    /**
     * Only from account deletion's revocation hook, after `markDeleted` (#772,
     * Q772C-004): the record is marked `revoked` through the deletion-only
     * method, since every other connection write now refuses a deleted account.
     */
    readonly accountDeletion?: boolean;
  } = {},
): Promise<{ readonly disconnected: boolean }> {
  const config = await requireConfig(runtime);
  const { connections, vault } = stores(uid, runtime);
  try {
    const record = await disconnectProviderOAuth(vault, connections, clientFor(config, runtime), {
      scopeId: uid,
      connectionId: connectionIdFor(GOOGLE_PROVIDER),
      now: runtime.now().toISOString(),
      ...(options.accountDeletion ? { accountDeletion: true } : {}),
    });
    // Identity-bound Gmail work cannot survive an account change. This runs
    // after provider revocation landed and before any later connection can be
    // admitted, preserving auto-add history while preventing reads of B under
    // A's monitor/scan authority.
    await runtime.storage.runTransaction(async tx => {
      const manualPath = `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/manualV2`;
      const dailyPath = `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/dailyV2`;
      const monitorPath = `${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`;
      const [manual, daily, monitor] = await Promise.all([
        tx.get<Record<string, unknown>>(manualPath),
        tx.get<Record<string, unknown>>(dailyPath),
        tx.get<Record<string, unknown>>(monitorPath),
      ]);
      const now = runtime.now().toISOString();
      for (const [path, scan] of [[manualPath, manual], [dailyPath, daily]] as const) {
        if (scan && (scan.status === 'running' || scan.status === 'failed')) tx.set(path, {
          ...scan, status: 'failed', failure: 'reconnect_needed', failedAt: now,
          leaseOwner: null, leaseUntil: null, nextEligibleAt: now,
        });
      }
      if (monitor) {
        const m5 = typeof monitor.m5 === 'object' && monitor.m5 !== null
          ? (({ nextSweepAt: _next, ...rest }) => rest)(monitor.m5 as Record<string, unknown>) : undefined;
        tx.set(monitorPath, {
          ...monitor, enabled: false, generation: randomUUID(), cursor: null, pageToken: null,
          leaseUntil: null, lease: null, nextPollAt: now, error: null,
          liveWaiting: null, proposalWaiting: null, proposalsPending: false,
          ...(m5 ? { m5 } : {}),
        });
      }
    });
    // After the revocation landed, never before: a refused revoke keeps the
    // grant, and the busy time that grant produced stays true with it.
    // `deleteBusySource` announces every removed block to the replan tick.
    const fenceGeneration = await advanceGoogleBusyFence(uid, runtime);
    await deleteBusySource(uid, GOOGLE_BUSY_SOURCE_ID, {
      storage: runtime.storage,
      now: runtime.now(),
      transactionGuard: async (tx) => {
        const fence = await tx.get<BusySourceReplacementFence>(googleBusyFencePath(uid));
        if (fence?.generation !== fenceGeneration) throw new GoogleConnectError('google_unavailable');
      },
    });
    return { disconnected: record !== null };
  } catch (error) {
    // A connection write the account deletion fence refused (#772): answered
    // as a deleted account, not as Google being unavailable.
    if (error instanceof AccountUnavailableError) throw error;
    throw asConnectError(error);
  }
}

/* ── Reading through the grant ─────────────────────────────────── */

/**
 * Before any content is read: the feature is connected and granted (a token
 * loads), and the person has agreed to AI processing. In that order, so a row
 * that is not connected says so rather than asking about consent first.
 */
export async function requireReadableFeature(
  uid: string,
  feature: Exclude<GoogleFeature, 'calendar'>,
  runtime: GoogleRuntime,
): Promise<void> {
  await googleAccessToken(uid, feature, runtime);
  if ((await getAiConsent(uid, { storage: runtime.storage })) !== 'granted') {
    throw new GoogleConnectError('ai_consent_required');
  }
}

/**
 * A bearer for one feature, or the refusal the row needs.
 *
 * Only the access token leaves this function — never the token set. A feature
 * the grant does not carry is refused before any token is loaded.
 */
export async function googleAccessToken(
  uid: string,
  feature: GoogleFeature,
  runtime: GoogleRuntime,
  options: { readonly forceRefresh?: boolean } = {},
): Promise<string> {
  const config = await requireConfig(runtime);
  const { connections, vault } = stores(uid, runtime);
  const record = await connections.get(connectionIdFor(GOOGLE_PROVIDER));
  if (!isLive(record)) throw new GoogleConnectError('google_not_connected');
  if (record.state === 'needs_reauth') throw new GoogleConnectError('google_reauth_required');
  if (!featuresGranted(record.grantedScopes)[feature]) throw new GoogleConnectError('google_feature_not_granted');
  const client = clientFor(config, runtime);
  const now = runtime.now().toISOString();
  try {
    if (options.forceRefresh) {
      const { tokenSet } = await refreshProviderAccessToken(vault, connections, client, {
        scopeId: uid,
        connectionId: record.connectionId,
        now,
      });
      return tokenSet.accessToken;
    }
    const token = await loadProviderAccessToken(
      { vault, connections, client },
      { scopeId: uid, connectionId: record.connectionId, now },
    );
    return token.accessToken;
  } catch (error) {
    // `refreshProviderAccessToken` has already moved the record to the state
    // the failure means (`needs_reauth` for Google's `invalid_grant`, which is
    // what a Testing-mode grant becomes on day eight).
    const after = await connections.get(record.connectionId);
    if (after?.state === 'needs_reauth') throw new GoogleConnectError('google_reauth_required');
    if (error instanceof ProviderAccessTokenError && error.code === 'reauth_required' && after?.state === 'connected') {
      // No refresh token left to trade in and nothing recorded that: only a
      // reconnect helps, and the row has to be able to say so.
      await connections.markState(record.connectionId, 'needs_reauth', now, 'refresh_unavailable');
      throw new GoogleConnectError('google_reauth_required');
    }
    // A refresh Google answered with a 5xx or a rate limit left the record in
    // `error`: that is "try again", not "reconnect".
    if (error instanceof ProviderOAuthError || error instanceof ProviderAccessTokenError) {
      throw new GoogleConnectError('google_unavailable');
    }
    throw asConnectError(error);
  }
}

/**
 * The resource call every feature makes: bearer in, one refresh-and-retry on a
 * 401, and a grant that still answers 401 after a refresh marked `needs_reauth`
 * — so the row says «أعد الربط» instead of failing the same way forever.
 */
export async function googleResourceFetch(
  uid: string,
  feature: GoogleFeature,
  runtime: GoogleRuntime,
  url: string,
  init: { readonly method?: 'GET' | 'POST'; readonly body?: string; readonly timeoutMs?: number } = {},
): Promise<Response> {
  const call = async (token: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('google request timed out', 'TimeoutError')),
      init.timeoutMs ?? 15_000,
    );
    try {
      return await runtime.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
    } catch {
      // A timeout or a reset socket. Nothing Google said, so nothing to name.
      throw new GoogleConnectError('google_unavailable');
    } finally {
      clearTimeout(timer);
    }
  };

  let response = await call(await googleAccessToken(uid, feature, runtime));
  if (response.status !== 401) return response;
  response = await call(await googleAccessToken(uid, feature, runtime, { forceRefresh: true }));
  if (response.status === 401) throw await markGoogleNeedsReauth(uid, runtime);
  return response;
}

/**
 * A grant that still answers 401 after a successful refresh is dead in a way
 * the token endpoint has not noticed yet. Recorded, so the row offers
 * «أعد الربط» instead of failing the same way on every press.
 */
export async function markGoogleNeedsReauth(uid: string, runtime: GoogleRuntime): Promise<GoogleConnectError> {
  await stores(uid, runtime).connections.markState(
    connectionIdFor(GOOGLE_PROVIDER),
    'needs_reauth',
    runtime.now().toISOString(),
    'resource_unauthorized',
  );
  return new GoogleConnectError('google_reauth_required');
}

/** A non-2xx from a resource call, as one closed reason. Never the body. */
export function refusalForResponse(response: Response): GoogleConnectError {
  if (response.status === 403) return new GoogleConnectError('google_permission_not_granted');
  if (response.status === 404) return new GoogleConnectError('google_file_unsupported');
  return new GoogleConnectError('google_unavailable');
}
