/**
 * A call that never completed is not a contract violation.
 *
 * `classifyProviderFailure` had no way to say "the request did not finish", so
 * the Gmail adapter's catch declared every non-`GmailProviderError` throw
 * `malformedResponse: true`. A socket timeout therefore read as
 * `malformed_response` — non-retryable, connection state `error` — which is
 * the opposite of what a flaky network deserves, and it accuses the provider
 * of breaking its contract on the strength of no response at all.
 *
 * These tests fix both halves in place: the taxonomy gains `transport_failure`
 * (retryable, connection state `connected`, exactly as `rate_limited` is
 * treated — the grant is still good and the user did nothing wrong), and the
 * adapter classifies a throw by what it actually is. The regression that
 * matters is the other direction: a genuinely malformed payload must still be
 * `malformed_response` and must still be non-retryable. The fix must not make
 * everything retryable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProviderFailure,
  PROVIDER_RUNTIME_SECURITY_POLICY,
} from '../../lib/integrations/providers/providerRuntime.ts';
import {
  GMAIL_SCOPES,
  GmailProviderError,
  runGmailIncrementalSync,
  type GmailSyncResult,
} from '../../lib/integrations/gmail/adapter.ts';
import { MemoryIntegrationConnectionStore } from '../../lib/integrations/connections/connectionRegistry.ts';
import { SafeFetchError } from '../../lib/net/safeFetch.ts';

const NOW = '2026-09-16T12:00:00.000Z';

async function connection(cursor: string | null = 'history-1') {
  return new MemoryIntegrationConnectionStore().upsert({
    scopeId: 'scope-a',
    identity: { provider: 'google', providerAccountId: 'google-1', providerSpaceId: null, displayName: 'Work' },
    state: 'connected',
    capabilities: ['mail_read'],
    grantedScopes: [GMAIL_SCOPES.read],
    sync: { cursor, checkpointAt: NOW },
    credentialRef: { vault: 'kms', keyId: 'gmail-1', version: '1' },
  }, NOW);
}

const activeToken = {
  accessTokenExpiresAt: '2026-09-16T13:00:00.000Z',
  refreshTokenExpiresAt: null,
  grantedScopes: [GMAIL_SCOPES.read],
  hasRefreshToken: true,
  revokedAt: null,
} as const;

function message(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    threadId: 'thread-1',
    historyId: 'history-2',
    receivedAt: '2026-09-16T11:00:00.000Z',
    from: 'teacher@example.test',
    subject: 'School follow-up',
    text: 'Please call the school tomorrow',
    ...over,
  };
}

/** Drives the real sync so the adapter's catch is exercised, not just the classifier. */
async function syncThrowing(
  error: unknown,
  options: { readonly firstPageSucceeds?: boolean; readonly logs?: unknown[] } = {},
): Promise<GmailSyncResult> {
  let page = 0;
  return runGmailIncrementalSync({
    listHistory: async () => {
      page += 1;
      if (options.firstPageSucceeds && page === 1) {
        return { historyId: 'history-2', messages: [message('m-1')], nextPageToken: 'next' };
      }
      throw error;
    },
  }, {
    connection: await connection(),
    token: activeToken,
    now: NOW,
    logger: options.logs ? { log: (event) => options.logs!.push(event) } : undefined,
  });
}

/** A Node socket timeout: an `Error` with a `code`, which is all a caller gets. */
function socketError(code: string, messageText = 'connect ETIMEDOUT'): Error {
  return Object.assign(new Error(messageText), { code });
}

/* ── The taxonomy ──────────────────────────────────────────────────── */

test('a call that never completed classifies as a retryable transport failure', () => {
  assert.deepEqual(classifyProviderFailure({ transportFailure: true }), {
    kind: 'transport_failure',
    retryable: true,
    connectionState: 'connected',
    safeErrorCode: 'provider_transport_failure',
  });
});

test('a transport failure leaves the connection usable, exactly as rate limiting does', () => {
  const transport = classifyProviderFailure({ transportFailure: true });
  const rateLimited = classifyProviderFailure({ httpStatus: 429 });

  // Same reasoning, so the same answer: nothing about a timeout says the grant
  // is bad or that the user must act. Only the kind may differ.
  assert.equal(transport.connectionState, rateLimited.connectionState);
  assert.equal(transport.retryable, rateLimited.retryable);
  assert.notEqual(transport.connectionState, 'error');
  assert.notEqual(transport.connectionState, 'needs_reauth');
});

test('a malformed payload is still non-retryable and still an error state', () => {
  // The regression that matters. Making timeouts retryable must not make a
  // provider that broke its contract look like a blip worth retrying.
  assert.deepEqual(classifyProviderFailure({ malformedResponse: true }), {
    kind: 'malformed_response',
    retryable: false,
    connectionState: 'error',
    safeErrorCode: 'provider_malformed_response',
  });
});

test('evidence of a response outranks evidence of none', () => {
  // If both are somehow asserted, a payload we actually received and could not
  // parse is the stronger signal; it must not be softened into a retry.
  const both = classifyProviderFailure({ malformedResponse: true, transportFailure: true });
  assert.equal(both.kind, 'malformed_response');
  assert.equal(both.retryable, false);
});

test('the existing kinds keep their classification', () => {
  assert.equal(classifyProviderFailure({ httpStatus: 401 }).kind, 'authentication_revoked');
  assert.equal(classifyProviderFailure({ httpStatus: 403 }).kind, 'permission_lost');
  assert.equal(classifyProviderFailure({ httpStatus: 410 }).kind, 'stale_cursor');
  assert.equal(classifyProviderFailure({ httpStatus: 409 }).kind, 'duplicate');
  assert.equal(classifyProviderFailure({ httpStatus: 503 }).kind, 'provider_unavailable');
  assert.equal(classifyProviderFailure({}).kind, 'unknown');
  assert.equal(classifyProviderFailure({}).retryable, false);
});

/* ── The detector ──────────────────────────────────────────────────── */

test('transport failures are recognised by code, by name, and through a cause chain', async () => {
  // Imported here rather than at the top of the file so the behavioural tests
  // above still load and report a real failure before this export exists.
  const { isProviderTransportFailure } = await import(
    '../../lib/integrations/providers/providerRuntime.ts'
  );

  for (const code of [
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE',
    'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'EPROTO',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
    'ERR_SOCKET_CONNECTION_TIMEOUT',
  ]) {
    assert.equal(isProviderTransportFailure(socketError(code)), true, code);
  }

  assert.equal(isProviderTransportFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  assert.equal(isProviderTransportFailure(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), true);
  assert.equal(isProviderTransportFailure(new SafeFetchError('timeout')), true);
  assert.equal(isProviderTransportFailure(new SafeFetchError('network')), true);

  // What `fetch` actually throws: a bare TypeError with the real reason nested.
  const fetchFailed = Object.assign(new TypeError('fetch failed'), {
    cause: socketError('UND_ERR_CONNECT_TIMEOUT'),
  });
  assert.equal(isProviderTransportFailure(fetchFailed), true);

  // And the negatives: a bug in our own code is not a network blip.
  assert.equal(isProviderTransportFailure(new TypeError('x.map is not a function')), false);
  assert.equal(isProviderTransportFailure(new Error('something went wrong')), false);
  assert.equal(isProviderTransportFailure(new SafeFetchError('blocked_host')), false);
  assert.equal(isProviderTransportFailure(new SafeFetchError('http_status', 500)), false);
  assert.equal(isProviderTransportFailure(null), false);
  assert.equal(isProviderTransportFailure('ETIMEDOUT'), false);
});

/* ── End to end through the adapter's catch ────────────────────────── */

test('a Gmail sync that times out is retryable and does not break the connection', async () => {
  const result = await syncThrowing(socketError('ETIMEDOUT'));

  assert.equal(result.failure?.kind, 'transport_failure');
  assert.equal(result.failure?.retryable, true);
  assert.notEqual(result.failure?.connectionState, 'error');
  assert.equal(result.failure?.connectionState, 'connected');
  // The cursor must not advance on a call that produced nothing.
  assert.equal(result.nextHistoryId, 'history-1');
});

test('a Gmail sync that fails the way fetch fails is a transport failure', async () => {
  const result = await syncThrowing(Object.assign(new TypeError('fetch failed'), {
    cause: socketError('UND_ERR_HEADERS_TIMEOUT'),
  }));

  assert.equal(result.failure?.kind, 'transport_failure');
  assert.equal(result.failure?.retryable, true);
});

test('a refused safe fetch is a transport failure, not a broken contract', async () => {
  const result = await syncThrowing(new SafeFetchError('timeout'));
  assert.equal(result.failure?.kind, 'transport_failure');
  assert.equal(result.failure?.retryable, true);
});

test('a timeout after a page still preserves the old cursor and stays retryable', async () => {
  const result = await syncThrowing(socketError('ECONNRESET'), { firstPageSucceeds: true });

  assert.equal(result.state, 'partial');
  assert.equal(result.items.length, 1);
  assert.equal(result.nextHistoryId, 'history-1');
  assert.equal(result.failure?.kind, 'transport_failure');
  assert.equal(result.failure?.retryable, true);
});

test('a Gmail payload that breaks its contract is still malformed and still not retried', async () => {
  // Raised inside the adapter at the missing-history-id guard.
  const missingHistoryId = await runGmailIncrementalSync({
    listHistory: async () => ({ historyId: '', messages: [], nextPageToken: null }),
  }, { connection: await connection(), token: activeToken, now: NOW });

  // Raised inside `normalizeGmailMessage` for an unparseable timestamp.
  const badTimestamp = await runGmailIncrementalSync({
    listHistory: async () => ({
      historyId: 'history-2',
      messages: [message('m-1', { receivedAt: 'not-a-date' })],
      nextPageToken: null,
    }),
  }, { connection: await connection(), token: activeToken, now: NOW });

  // And one raised explicitly by the port, as a real transport would.
  const explicit = await syncThrowing(new GmailProviderError('bad payload', null, false, true));

  for (const result of [missingHistoryId, badTimestamp, explicit]) {
    assert.equal(result.failure?.kind, 'malformed_response');
    assert.equal(result.failure?.retryable, false);
    assert.equal(result.failure?.connectionState, 'error');
  }
});

test('an HTTP failure is still classified by its status, not as a transport failure', async () => {
  for (const [status, kind] of [[401, 'authentication_revoked'], [429, 'rate_limited'], [503, 'provider_unavailable']] as const) {
    const result = await syncThrowing(new GmailProviderError('provider said no', status));
    assert.equal(result.failure?.kind, kind, String(status));
  }
});

test('a throw that is neither a provider error nor a transport failure is unknown, not malformed', async () => {
  // A bug in our own port code. We have no evidence of a malformed payload —
  // we have no evidence of a payload at all — so the honest answer is
  // `unknown`, and it must not be retried.
  const result = await syncThrowing(new TypeError('page.messages is not iterable'));

  assert.equal(result.failure?.kind, 'unknown');
  assert.equal(result.failure?.retryable, false);
  assert.notEqual(result.failure?.kind, 'malformed_response');
});

/* ── The security invariant ────────────────────────────────────────── */

test('a timeout surfaces no URL, host, request body, or token', async () => {
  const secrets = [
    'https://gmail.googleapis.com/gmail/v1/users/me/history',
    'gmail.googleapis.com',
    'ya29.a0ARrdaM-SECRET-ACCESS-TOKEN',
    '{"startHistoryId":"history-1"}',
  ];
  const logs: unknown[] = [];
  const result = await syncThrowing(
    Object.assign(new Error(`connect ETIMEDOUT ${secrets.join(' ')}`), {
      code: 'ETIMEDOUT',
      cause: Object.assign(new Error(secrets.join(' ')), { code: 'ETIMEDOUT' }),
    }),
    { logs },
  );

  assert.equal(result.failure?.kind, 'transport_failure');

  const surfaced = JSON.stringify({ result, logs });
  for (const secret of secrets) {
    assert.equal(surfaced.includes(secret), false, secret);
  }
  // A fixed code per kind, in the manner of `SafeFetchError` — never the URL.
  assert.equal(result.failure?.safeErrorCode, 'provider_transport_failure');
  assert.deepEqual(Object.keys(result.failure ?? {}).sort(), [
    'connectionState', 'kind', 'retryable', 'safeErrorCode',
  ]);
  assert.equal(PROVIDER_RUNTIME_SECURITY_POLICY.providerPayloadInGenericLogs, false);
  assert.equal(PROVIDER_RUNTIME_SECURITY_POLICY.rawCredentialsInLogs, false);
});
