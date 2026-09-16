import { createHash, randomBytes } from 'node:crypto';
import type {
  ContextProviderKind,
  IntegrationCapability,
  IntegrationConnectionRecord,
  IntegrationConnectionStore,
  IntegrationCredentialReference,
  IntegrationProviderIdentity,
} from '../../../src/contracts/v1/integrationConnectionContracts';
import type {
  ProviderCredentialVault,
  ProviderOAuthTokenSet,
} from './providerRuntime';

const DEFAULT_STATE_TTL_MS = 10 * 60_000;

export type ProviderOAuthFailureCode =
  | 'invalid_request'
  | 'invalid_or_replayed_state'
  | 'state_scope_mismatch'
  | 'provider_mismatch'
  | 'scope_mismatch'
  | 'malformed_provider_identity'
  | 'credential_store_failed'
  | 'connection_store_failed'
  | 'revocation_failed';

export class ProviderOAuthError extends Error {
  constructor(readonly code: ProviderOAuthFailureCode) {
    super(code);
    this.name = 'ProviderOAuthError';
  }
}

export interface ProviderOAuthState {
  readonly state: string;
  readonly scopeId: string;
  readonly provider: ContextProviderKind;
  readonly capabilities: readonly IntegrationCapability[];
  readonly requestedScopes: readonly string[];
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ProviderOAuthStateStore {
  create(value: ProviderOAuthState): Promise<void>;
  /** Atomically removes and returns a state. Missing, expired, and replayed states return null. */
  consume(state: string, now: string): Promise<ProviderOAuthState | null>;
}

export class MemoryProviderOAuthStateStore implements ProviderOAuthStateStore {
  private readonly states = new Map<string, ProviderOAuthState>();

  async create(value: ProviderOAuthState): Promise<void> {
    if (this.states.has(value.state)) throw new ProviderOAuthError('invalid_request');
    this.states.set(value.state, freezeState(value));
  }

  async consume(state: string, now: string): Promise<ProviderOAuthState | null> {
    const value = this.states.get(state) ?? null;
    this.states.delete(state);
    if (!value) return null;
    const nowMs = Date.parse(now);
    const expiresAtMs = Date.parse(value.expiresAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;
    return value;
  }
}

export interface ProviderOAuthClient {
  readonly provider: ContextProviderKind;
  exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
  }): Promise<ProviderOAuthTokenSet>;
  loadIdentity(tokenSet: ProviderOAuthTokenSet): Promise<IntegrationProviderIdentity>;
  revoke(tokenSet: ProviderOAuthTokenSet): Promise<void>;
}

export interface BeginProviderOAuthInput {
  readonly scopeId: string;
  readonly provider: ContextProviderKind;
  readonly capabilities: readonly IntegrationCapability[];
  readonly requestedScopes: readonly string[];
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly now: string;
  readonly stateTtlMs?: number;
}

export interface BeginProviderOAuthResult {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAt: string;
}

export async function beginProviderOAuth(
  stateStore: ProviderOAuthStateStore,
  input: BeginProviderOAuthInput,
  random: (size: number) => Buffer = randomBytes,
): Promise<BeginProviderOAuthResult> {
  const nowMs = Date.parse(input.now);
  const ttlMs = input.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
  if (
    !input.scopeId.trim()
    || !input.clientId.trim()
    || !Number.isFinite(nowMs)
    || !Number.isFinite(ttlMs)
    || ttlMs <= 0
    || ttlMs > DEFAULT_STATE_TTL_MS
  ) {
    throw new ProviderOAuthError('invalid_request');
  }

  const authorizationEndpoint = secureUrl(input.authorizationEndpoint);
  const redirectUri = redirectUrl(input.redirectUri);
  const capabilities = uniqueSorted(input.capabilities);
  const requestedScopes = uniqueSorted(input.requestedScopes.filter((scope) => scope.trim().length > 0));
  if (capabilities.length === 0 || requestedScopes.length === 0) {
    throw new ProviderOAuthError('invalid_request');
  }

  const state = base64url(random(32));
  const codeVerifier = base64url(random(48));
  if (state.length < 32 || codeVerifier.length < 43) throw new ProviderOAuthError('invalid_request');
  const expiresAt = new Date(nowMs + ttlMs).toISOString();

  await stateStore.create({
    state,
    scopeId: input.scopeId,
    provider: input.provider,
    capabilities,
    requestedScopes,
    redirectUri: redirectUri.toString(),
    codeVerifier,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt,
  });

  authorizationEndpoint.searchParams.set('response_type', 'code');
  authorizationEndpoint.searchParams.set('client_id', input.clientId);
  authorizationEndpoint.searchParams.set('redirect_uri', redirectUri.toString());
  authorizationEndpoint.searchParams.set('scope', requestedScopes.join(' '));
  authorizationEndpoint.searchParams.set('state', state);
  authorizationEndpoint.searchParams.set('code_challenge', sha256base64url(codeVerifier));
  authorizationEndpoint.searchParams.set('code_challenge_method', 'S256');

  return Object.freeze({ authorizationUrl: authorizationEndpoint.toString(), state, expiresAt });
}

export interface CompleteProviderOAuthInput {
  readonly scopeId: string;
  readonly provider: ContextProviderKind;
  readonly state: string;
  readonly code: string;
  readonly now: string;
}

export async function completeProviderOAuth(
  stateStore: ProviderOAuthStateStore,
  vault: ProviderCredentialVault,
  connections: IntegrationConnectionStore,
  client: ProviderOAuthClient,
  input: CompleteProviderOAuthInput,
): Promise<IntegrationConnectionRecord> {
  if (!input.scopeId.trim() || !input.state.trim() || !input.code.trim() || !Number.isFinite(Date.parse(input.now))) {
    throw new ProviderOAuthError('invalid_request');
  }

  const state = await stateStore.consume(input.state, input.now);
  if (!state) throw new ProviderOAuthError('invalid_or_replayed_state');
  if (state.scopeId !== input.scopeId) throw new ProviderOAuthError('state_scope_mismatch');
  if (state.provider !== input.provider || client.provider !== input.provider) {
    throw new ProviderOAuthError('provider_mismatch');
  }

  const tokenSet = await client.exchangeAuthorizationCode({
    code: input.code,
    redirectUri: state.redirectUri,
    codeVerifier: state.codeVerifier,
  });
  validateTokenSet(tokenSet);
  if (state.requestedScopes.some((scope) => !tokenSet.grantedScopes.includes(scope))) {
    throw new ProviderOAuthError('scope_mismatch');
  }

  const identity = await client.loadIdentity(tokenSet);
  if (identity.provider !== input.provider) throw new ProviderOAuthError('provider_mismatch');
  if (!identity.providerAccountId?.trim()) throw new ProviderOAuthError('malformed_provider_identity');

  let credentialRef: IntegrationCredentialReference;
  try {
    credentialRef = await vault.storeOAuthTokenSet({
      scopeId: input.scopeId,
      provider: input.provider,
      tokenSet,
    });
  } catch {
    throw new ProviderOAuthError('credential_store_failed');
  }

  try {
    return await connections.upsert({
      scopeId: input.scopeId,
      identity,
      state: 'connected',
      capabilities: state.capabilities,
      grantedScopes: tokenSet.grantedScopes,
      connectedAt: input.now,
      expiresAt: tokenSet.accessTokenExpiresAt,
      credentialRef,
      sync: { cursor: null, checkpointAt: null },
      provenance: { source: 'oauth', connectedBy: 'user', recordedAt: input.now },
    }, input.now);
  } catch {
    await vault.delete(credentialRef).catch(() => undefined);
    throw new ProviderOAuthError('connection_store_failed');
  }
}

export interface DisconnectProviderOAuthInput {
  readonly scopeId: string;
  readonly connectionId: string;
  readonly now: string;
}

export async function disconnectProviderOAuth(
  vault: ProviderCredentialVault,
  connections: IntegrationConnectionStore,
  client: ProviderOAuthClient,
  input: DisconnectProviderOAuthInput,
): Promise<IntegrationConnectionRecord | null> {
  const connection = await connections.get(input.connectionId);
  if (!connection) return null;
  if (connection.scopeId !== input.scopeId) throw new ProviderOAuthError('state_scope_mismatch');
  if (connection.identity.provider !== client.provider) throw new ProviderOAuthError('provider_mismatch');

  const credentialRef = connection.credentialRef ?? null;
  const tokenSet = credentialRef ? await vault.loadOAuthTokenSet(credentialRef) : null;
  if (tokenSet) {
    try {
      await client.revoke(tokenSet);
    } catch {
      await connections.markState(connection.connectionId, 'error', input.now, 'oauth_revoke_failed');
      throw new ProviderOAuthError('revocation_failed');
    }
  }
  if (credentialRef) await vault.delete(credentialRef);
  return connections.markState(connection.connectionId, 'revoked', input.now);
}

function validateTokenSet(tokenSet: ProviderOAuthTokenSet): void {
  if (!tokenSet.accessToken.trim() || tokenSet.grantedScopes.length === 0) {
    throw new ProviderOAuthError('invalid_request');
  }
  for (const value of [tokenSet.accessTokenExpiresAt, tokenSet.refreshTokenExpiresAt]) {
    if (value !== null && !Number.isFinite(Date.parse(value))) throw new ProviderOAuthError('invalid_request');
  }
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze(Array.from(new Set(values)).sort());
}

function secureUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe');
    return url;
  } catch {
    throw new ProviderOAuthError('invalid_request');
  }
}

function redirectUrl(value: string): URL {
  try {
    const url = new URL(value);
    const local = (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.protocol === 'http:';
    if ((url.protocol !== 'https:' && !local) || url.username || url.password) throw new Error('unsafe');
    return url;
  } catch {
    throw new ProviderOAuthError('invalid_request');
  }
}

function base64url(value: Buffer): string {
  return value.toString('base64url');
}

function sha256base64url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function freezeState(value: ProviderOAuthState): ProviderOAuthState {
  Object.freeze(value.capabilities);
  Object.freeze(value.requestedScopes);
  return Object.freeze({ ...value });
}
