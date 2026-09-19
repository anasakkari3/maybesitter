/**
 * The Gmail production read transport, offline (Phase B).
 *
 * **Nothing here contacts Gmail.** Every response is a fixture in
 * `tests/fixtures/gmail/`, transcribed from Google's REST v1 documentation as
 * fetched on 2026-09-19 and catalogued with its source URL in
 * `evidence/gmail-phase-b/CONTRACT.md`. A fixture proves the client does what
 * we told the fixture to expect; it can never prove Google agrees. The honest
 * claim these tests support is "verified offline against documented fixtures",
 * and no result here may be described as verified live.
 *
 * Every case drives `runGmailIncrementalSync` — the real adapter, with the real
 * page loop, dedupe, cursor rule and failure classifier — rather than poking
 * the transport directly, because the defects worth catching live in the seam
 * between the two. The scripted `fetch` asserts on the *outgoing* request as
 * much as it scripts the incoming one: half of what Phase B must get right is
 * what it sends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GMAIL_SCOPES,
  runGmailIncrementalSync,
  type GmailSyncResult,
} from '../../lib/integrations/gmail/adapter.ts';
import {
  createGmailTransport,
  decodeBase64Url,
  gmailBackoffMs,
  GMAIL_MAX_PAGE_SIZE,
  GMAIL_PHASE_B_SCOPES,
  GMAIL_TRANSPORT_POLICY,
  GmailHttpError,
  GmailWireError,
  type GmailTransportDeps,
} from '../../lib/integrations/gmail/production/gmailTransport.ts';
import {
  MemoryIntegrationConnectionStore,
  recordConnectionSync,
} from '../../lib/integrations/connections/connectionRegistry.ts';
import { ProviderProbeHttpError } from '../../lib/verification/liveProviderVerification.ts';
import {
  BODY_TEXT_PLAIN,
  ERROR_401_INVALID_CREDENTIALS,
  ERROR_403_INSUFFICIENT_SCOPE,
  ERROR_404_HISTORY_CURSOR_TOO_OLD,
  ERROR_404_MESSAGE_NOT_FOUND,
  ERROR_429_TOO_MANY_REQUESTS,
  ERROR_500_BACKEND,
  ERROR_502_HTML_BODY,
  HISTORY_CURSOR_FRESH,
  HISTORY_LIST_EMPTY,
  HISTORY_LIST_PAGE_1,
  HISTORY_LIST_PAGE_2,
  HISTORY_PAGE_TOKEN,
  MALFORMED_HISTORY_NO_HISTORY_ID,
  MALFORMED_HISTORY_NUMERIC_ID,
  MALFORMED_HISTORY_REPEATING_PAGE_TOKEN,
  MALFORMED_MESSAGE_NULL_ID,
  MALFORMED_TOP_LEVEL_ARRAY,
  MESSAGES_LIST_EMPTY,
  MESSAGES_LIST_PAGE_1,
  MESSAGE_FULL,
  MESSAGE_FULL_WITH_ATTACHMENT,
  MSG_ID_1,
  MSG_ID_2,
  MSG_ID_3,
  PROFILE_OK,
} from '../fixtures/gmail/index.ts';

const NOW = '2026-09-19T12:00:00.000Z';
const TOKEN = 'ya29.a0ARrdaM-FIXTURE-ACCESS-TOKEN-do-not-log';

/* ── A scripted HTTP client ────────────────────────────────────── */

type Reply = { status: number; body: unknown; contentType?: string } | { throws: unknown } | 'hang';

interface Call {
  readonly endpoint: string;
  readonly url: URL;
  readonly authorization: string | null;
}

interface Script {
  profile?: Reply | Reply[];
  history?: Reply | Reply[];
  messagesList?: Reply | Reply[];
  messagesGet?: Reply | Reply[] | ((id: string) => Reply);
}

function classify(url: URL): { endpoint: keyof Script; messageId: string | null } {
  const path = url.pathname;
  if (path.endsWith('/profile')) return { endpoint: 'profile', messageId: null };
  if (path.endsWith('/history')) return { endpoint: 'history', messageId: null };
  const get = /\/messages\/([^/]+)$/.exec(path);
  if (get) return { endpoint: 'messagesGet', messageId: decodeURIComponent(get[1]) };
  if (path.endsWith('/messages')) return { endpoint: 'messagesList', messageId: null };
  throw new Error(`unscripted gmail path: ${path}`);
}

function ok(body: unknown): Reply {
  return { status: 200, body };
}

/** Builds a `fetch` that scripts replies and records every outgoing request. */
function scriptedFetch(script: Script): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const cursors = new Map<string, number>();

  const next = (endpoint: keyof Script, messageId: string | null): Reply => {
    const entry = script[endpoint];
    if (entry === undefined) throw new Error(`unscripted gmail endpoint: ${endpoint}`);
    if (typeof entry === 'function') return entry(messageId ?? '');
    if (!Array.isArray(entry)) return entry;
    const index = cursors.get(endpoint) ?? 0;
    cursors.set(endpoint, index + 1);
    // The last scripted reply repeats, so "always fails" needs one entry.
    return entry[Math.min(index, entry.length - 1)];
  };

  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const { endpoint, messageId } = classify(url);
    const headers = new Headers(init?.headers);
    calls.push({ endpoint, url, authorization: headers.get('authorization') });

    const reply = next(endpoint, messageId);

    if (reply === 'hang') {
      // Never resolves on its own: the only way out is the transport's abort,
      // which proves the signal is actually wired through rather than that the
      // promise was merely abandoned.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    if ('throws' in reply) throw reply.throws;

    const isString = typeof reply.body === 'string';
    return new Response(isString ? (reply.body as string) : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': reply.contentType ?? (isString ? 'text/html' : 'application/json') },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/** A message body for an id the fixtures do not carry one for. */
function messageFor(id: string): Reply {
  if (id === MSG_ID_1) return ok(MESSAGE_FULL.body);
  if (id === MSG_ID_2) return ok(MESSAGE_FULL_WITH_ATTACHMENT.body);
  if (id === MSG_ID_3) return ok({ ...MESSAGE_FULL.body, id: MSG_ID_3, historyId: '2418885' });
  throw new Error(`no fixture for message ${id}`);
}

/* ── The adapter above the transport ───────────────────────────── */

async function connection(cursor: string | null = HISTORY_CURSOR_FRESH) {
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
  accessTokenExpiresAt: '2026-09-19T13:00:00.000Z',
  refreshTokenExpiresAt: null,
  grantedScopes: [GMAIL_SCOPES.read],
  hasRefreshToken: true,
  revokedAt: null,
} as const;

/** Test defaults: no real timers, no real clock, no real randomness. */
function transportDeps(fetchImpl: typeof fetch, over: Partial<GmailTransportDeps> = {}): GmailTransportDeps {
  return {
    accessToken: async () => TOKEN,
    fetchImpl,
    env: {},
    sleep: async () => {},
    random: () => 0.5,
    monotonicMs: () => 0,
    ...over,
  };
}

interface SyncOptions {
  readonly cursor?: string | null;
  readonly logs?: unknown[];
  readonly maxPages?: number;
  readonly deps?: Partial<GmailTransportDeps>;
}

async function sync(script: Script, options: SyncOptions = {}): Promise<{
  result: GmailSyncResult;
  calls: Call[];
}> {
  const { fetchImpl, calls } = scriptedFetch(script);
  const transport = createGmailTransport(transportDeps(fetchImpl, options.deps));
  const result = await runGmailIncrementalSync(transport, {
    connection: await connection(options.cursor === undefined ? HISTORY_CURSOR_FRESH : options.cursor),
    token: activeToken,
    now: NOW,
    maxPages: options.maxPages,
    logger: options.logs ? { log: (event) => options.logs!.push(event) } : undefined,
  });
  return { result, calls };
}

const TWO_PAGE_SCRIPT: Script = {
  history: [ok(HISTORY_LIST_PAGE_1.body), ok(HISTORY_LIST_PAGE_2.body)],
  messagesGet: messageFor,
};

/* ══ The happy path ═══════════════════════════════════════════════ */

test('a two-page history walk dedupes, ignores label churn, and advances the cursor only on completion', async () => {
  const { result, calls } = await sync(TWO_PAGE_SCRIPT);

  assert.equal(result.state, 'complete');
  // Page 1 adds two messages, page 2 adds one and *removes a label* from a
  // message already seen. Label churn is not an ingest: three items, not four.
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map((item) => item.externalId).sort(), [MSG_ID_1, MSG_ID_2, MSG_ID_3]);
  // Only a completed walk moves the cursor, and it moves to the final page's id.
  assert.equal(result.nextHistoryId, '2418890');

  // The fan-out is exactly one `messages.get` per distinct id — never a second
  // fetch for the id that appears on both pages.
  const gets = calls.filter((call) => call.endpoint === 'messagesGet');
  assert.equal(gets.length, 3);
  assert.equal(new Set(gets.map((call) => call.url.pathname)).size, 3);
  assert.equal(calls.filter((call) => call.endpoint === 'history').length, 2);
});

test('the outgoing history request carries what Google documents and nothing else', async () => {
  const { calls } = await sync(TWO_PAGE_SCRIPT);
  const [first, second] = calls.filter((call) => call.endpoint === 'history');

  assert.equal(first.url.searchParams.get('startHistoryId'), HISTORY_CURSOR_FRESH);
  // Read-only: the only change worth ingesting is a new message.
  assert.equal(first.url.searchParams.get('historyTypes'), 'messageAdded');
  assert.equal(first.url.searchParams.get('pageToken'), null);

  // Page 2 repeats every parameter unchanged and adds the token. A retry or a
  // page turn that silently drops `startHistoryId` loses a page.
  assert.equal(second.url.searchParams.get('startHistoryId'), HISTORY_CURSOR_FRESH);
  assert.equal(second.url.searchParams.get('historyTypes'), 'messageAdded');
  assert.equal(second.url.searchParams.get('pageToken'), HISTORY_PAGE_TOKEN);

  // `format` is explicit on every get: Google documents no default.
  for (const call of calls.filter((entry) => entry.endpoint === 'messagesGet')) {
    assert.equal(call.url.searchParams.get('format'), 'full');
  }
});

test('an empty history read still advances the cursor', async () => {
  // `history` is absent, not `[]`, and `historyId` has still moved on. A client
  // that declines to store it leaves the cursor drifting towards expiry for
  // no reason.
  const { result, calls } = await sync({ history: ok(HISTORY_LIST_EMPTY.body) });

  assert.equal(result.state, 'complete');
  assert.equal(result.items.length, 0);
  assert.equal(result.nextHistoryId, '2418890');
  assert.equal(calls.filter((call) => call.endpoint === 'messagesGet').length, 0);
});

test('a connection with no cursor baselines from the profile and ingests nothing', async () => {
  // `startHistoryId` is a required parameter of `history.list`, so a first
  // sync cannot call it at all. The documented baseline is
  // `getProfile.historyId`, and taking it means Phase B starts from now rather
  // than backfilling a whole mailbox on connect.
  const { result, calls } = await sync({ profile: ok(PROFILE_OK.body) }, { cursor: null });

  assert.equal(result.state, 'complete');
  assert.equal(result.items.length, 0);
  assert.equal(result.nextHistoryId, '2418890');
  assert.deepEqual(calls.map((call) => call.endpoint), ['profile']);
});

test('a message is assembled from the get, not from the history stub', async () => {
  const { result } = await sync(TWO_PAGE_SCRIPT);
  const item = result.items.find((entry) => entry.externalId === MSG_ID_1);

  // None of these four fields exists anywhere in `history.list` output. If the
  // transport wired the history stub straight into the port they would be
  // empty or invented.
  assert.equal(item?.subject, 'Practice moved to Thursday');
  assert.equal(item?.from, 'Coach Dana <dana@example.org>');
  assert.equal(item?.receivedAt, new Date(1_789_632_842_000).toISOString());
  assert.equal(item?.text, BODY_TEXT_PLAIN);
});

test('text/plain wins over text/html, and attachment bytes are never fetched', async () => {
  const { result, calls } = await sync(TWO_PAGE_SCRIPT);
  const withAttachment = result.items.find((entry) => entry.externalId === MSG_ID_2);

  assert.equal(withAttachment?.text, BODY_TEXT_PLAIN);
  assert.equal(withAttachment?.text.includes('<div'), false);
  // The attachment part carries an `attachmentId` and no data. Fetching it is
  // a separate endpoint this transport must never reach.
  assert.equal(calls.some((call) => call.url.pathname.includes('/attachments')), false);
  assert.equal(JSON.stringify(result).includes('ANGjdJ_fixture_attachment_token_0001'), false);
  assert.equal(GMAIL_TRANSPORT_POLICY.fetchesAttachmentBytes, false);
});

test('base64url is decoded by its own alphabet and a standard-base64 body is rejected', async () => {
  // Real round trip: the fixture's encoding is genuine, so this compares
  // decoded bytes against declared plaintext rather than a string to itself.
  const part = MESSAGE_FULL.body.payload?.parts?.[0];
  assert.equal(decodeBase64Url(String(part?.body.data), 'messages.get'), BODY_TEXT_PLAIN);

  // `+`, `/` and embedded `=` are standard base64, not base64url. Decoding
  // them under the wrong alphabet produces plausible, wrong bytes, so this
  // must throw rather than guess.
  assert.throws(() => decodeBase64Url('SGks+/DQo=Zm9v', 'messages.get'), /no readable base64url body data/);
});

/* ══ Failure classification ═══════════════════════════════════════ */

test('a mid-walk 5xx yields partial with the OLD cursor', async () => {
  const { result } = await sync({
    history: [ok(HISTORY_LIST_PAGE_1.body), { status: 500, body: ERROR_500_BACKEND.body }],
    messagesGet: messageFor,
  });

  assert.equal(result.state, 'partial');
  assert.equal(result.items.length, 2);
  // The cursor must not advance past pages that failed. Advancing here would
  // lose page two forever.
  assert.equal(result.nextHistoryId, HISTORY_CURSOR_FRESH);
  assert.equal(result.failure?.kind, 'provider_unavailable');
  assert.equal(result.failure?.retryable, true);
});

test('an expired cursor is a 404 and yields cursor_reset_required', async () => {
  const { result } = await sync({
    history: { status: 404, body: ERROR_404_HISTORY_CURSOR_TOO_OLD.body },
  });

  // Google documents the *status* for a stale `startHistoryId` and never a
  // body, so this is asserted by the caller that knows which call it made —
  // not guessed by the classifier, and never read off a `reason` string.
  assert.equal(result.failure?.kind, 'stale_cursor');
  assert.equal(result.state, 'cursor_reset_required');
  assert.equal(result.nextHistoryId, HISTORY_CURSOR_FRESH);
});

test('the stale-cursor 404 is classified with the reason string stripped out', async () => {
  // The body is [OBS] in the contract, not documented. If classification
  // depended on it, this bare envelope would classify differently — and
  // production would drift the day Google changed a string.
  const { result } = await sync({
    history: { status: 404, body: { error: { code: 404, message: 'Not Found' } } },
  });

  assert.equal(result.failure?.kind, 'stale_cursor');
  assert.equal(result.state, 'cursor_reset_required');
  assert.equal(GMAIL_TRANSPORT_POLICY.classifiesOnResponseBody, false);
});

test('a 404 from messages.get is a deleted message, skipped, not a stale cursor', async () => {
  // The two 404s mean opposite things and only the caller can tell them apart.
  // This one must not reset the cursor and must not fail the page.
  const { result } = await sync({
    history: ok(HISTORY_LIST_PAGE_1.body),
    messagesGet: (id) =>
      id === MSG_ID_1 ? { status: 404, body: ERROR_404_MESSAGE_NOT_FOUND.body } : messageFor(id),
  });

  assert.notEqual(result.failure?.kind, 'stale_cursor');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.externalId, MSG_ID_2);
});

test('a 5xx from messages.get is surfaced, not swallowed like a deleted message', async () => {
  // The deleted-message skip must be narrow. A mutation that widened it to
  // every HTTP error survived the suite once: a page would then come back
  // looking complete while quietly dropping mail the provider had simply
  // failed to return, and the cursor would advance past it.
  const { result } = await sync({
    history: ok(HISTORY_LIST_PAGE_1.body),
    messagesGet: (id) =>
      id === MSG_ID_1 ? { status: 500, body: ERROR_500_BACKEND.body } : messageFor(id),
  });

  assert.equal(result.failure?.kind, 'provider_unavailable');
  assert.equal(result.failure?.retryable, true);
  assert.notEqual(result.state, 'complete');
  assert.equal(result.nextHistoryId, HISTORY_CURSOR_FRESH, 'the cursor must not advance past dropped mail');
});

test('a 403 from messages.get is surfaced too', async () => {
  const { result } = await sync({
    history: ok(HISTORY_LIST_PAGE_1.body),
    messagesGet: (id) =>
      id === MSG_ID_1 ? { status: 403, body: ERROR_403_INSUFFICIENT_SCOPE.body } : messageFor(id),
  });

  assert.equal(result.failure?.kind, 'permission_lost');
  assert.notEqual(result.state, 'complete');
});

test('a 401 with no way to re-authenticate is authentication_revoked', async () => {
  const { result, calls } = await sync({
    history: { status: 401, body: ERROR_401_INVALID_CREDENTIALS.body },
  });

  assert.equal(result.failure?.kind, 'authentication_revoked');
  assert.equal(result.failure?.retryable, false);
  assert.equal(result.failure?.connectionState, 'needs_reauth');
  // Not a backoff case: asked once, not five times.
  assert.equal(calls.length, 1);
});

test('a 401 refreshes the token and retries exactly once', async () => {
  let reauths = 0;
  const { result, calls } = await sync(
    {
      history: [{ status: 401, body: ERROR_401_INVALID_CREDENTIALS.body }, ok(HISTORY_LIST_EMPTY.body)],
    },
    { deps: { reauth: async () => { reauths += 1; return 'refreshed-token'; } } },
  );

  assert.equal(reauths, 1);
  assert.equal(calls.length, 2, 'exactly one retry: not three, not unbounded');
  assert.equal(result.state, 'complete');
  assert.equal(result.failure, null);
});

test('a second 401 after a refresh gives up rather than looping', async () => {
  let reauths = 0;
  const { result, calls } = await sync(
    { history: { status: 401, body: ERROR_401_INVALID_CREDENTIALS.body } },
    { deps: { reauth: async () => { reauths += 1; return 'refreshed-token'; } } },
  );

  assert.equal(reauths, 1);
  assert.equal(calls.length, 2);
  assert.equal(result.failure?.kind, 'authentication_revoked');
});

test('a 403 is a permission failure and is not retried', async () => {
  const { result, calls } = await sync({
    history: { status: 403, body: ERROR_403_INSUFFICIENT_SCOPE.body },
  });

  assert.equal(result.failure?.kind, 'permission_lost');
  assert.equal(result.failure?.retryable, false);
  assert.equal(calls.length, 1);
  // NOTE: Gmail also signals rate limiting with 403, and telling the two apart
  // needs the response body, which `ProviderFailureInput` cannot carry. That
  // is deliberately out of scope here and tracked separately; today every 403
  // is a permission failure, which is what this pins.
});

test('a 429 backs off, retries, and reports a retryable failure on exhaustion', async () => {
  const delays: number[] = [];
  const { result, calls } = await sync(
    { history: { status: 429, body: ERROR_429_TOO_MANY_REQUESTS.body } },
    { deps: { sleep: async (ms) => { delays.push(ms); } } },
  );

  assert.equal(calls.length, 5, 'one attempt plus four retries');
  // min(2^n * 1000 + jitter, 32000) with the RNG pinned at 0.5 → +500ms.
  assert.deepEqual(delays, [1_500, 2_500, 4_500, 8_500]);
  assert.equal(result.failure?.kind, 'rate_limited');
  assert.equal(result.failure?.retryable, true);
});

test('backoff is capped and its jitter really varies', async () => {
  // A hard-coded schedule would pass an "it retried" test. This one pins the
  // formula: the cap holds, and two different RNG draws give two delays.
  assert.equal(gmailBackoffMs(20, () => 0), 32_000);
  assert.equal(gmailBackoffMs(1, () => 0), 1_000);
  assert.equal(gmailBackoffMs(1, () => 1), 2_000);
  assert.notEqual(gmailBackoffMs(3, () => 0.1), gmailBackoffMs(3, () => 0.9));
  for (let attempt = 1; attempt < 40; attempt += 1) {
    assert.ok(gmailBackoffMs(attempt, Math.random) <= 32_000);
  }
});

test('a 502 carrying HTML is a retryable backend error, not a parse failure', async () => {
  // Google's front end returns HTML for some 502s. A classifier that calls
  // JSON.parse unguarded throws inside its own error path and reports a
  // contract violation instead of a blip worth retrying.
  const { result } = await sync({
    history: { status: 502, body: ERROR_502_HTML_BODY.body, contentType: 'text/html' },
  });

  assert.equal(result.failure?.kind, 'provider_unavailable');
  assert.equal(result.failure?.retryable, true);
  assert.notEqual(result.failure?.kind, 'malformed_response');
});

test('a request that never completes aborts and classifies as transport_failure', async () => {
  // The stub only ever settles when the transport's own `AbortSignal` fires,
  // so this proves the signal is wired through rather than that the promise
  // was abandoned.
  const { result } = await sync({ history: 'hang' }, { deps: { timeoutMs: 5 } });

  assert.equal(result.failure?.kind, 'transport_failure');
  assert.equal(result.failure?.retryable, true);
  // The connection is not the user's fault and the grant is still good.
  assert.equal(result.failure?.connectionState, 'connected');
});

test('a reset socket is a transport failure and is retried on the backoff', async () => {
  const delays: number[] = [];
  const { result, calls } = await sync(
    { history: { throws: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) } },
    { deps: { sleep: async (ms) => { delays.push(ms); } } },
  );

  assert.equal(calls.length, 5);
  assert.deepEqual(delays, [1_500, 2_500, 4_500, 8_500]);
  assert.equal(result.failure?.kind, 'transport_failure');
});

/* ══ Malformed payloads ═══════════════════════════════════════════ */

const MALFORMED_CASES: readonly (readonly [string, Script])[] = [
  ['history with no historyId', { history: ok(MALFORMED_HISTORY_NO_HISTORY_ID.body) }],
  ['history with a numeric historyId', { history: ok(MALFORMED_HISTORY_NUMERIC_ID.body) }],
  ['a top-level array', { history: ok(MALFORMED_TOP_LEVEL_ARRAY.body) }],
  ['a history array that is not an array', { history: ok({ history: {}, historyId: '2418890' }) }],
  [
    'a message with a null id',
    { history: ok(HISTORY_LIST_PAGE_2.body), messagesGet: ok(MALFORMED_MESSAGE_NULL_ID.body) },
  ],
  [
    'a message whose internalDate is an RFC 2822 date',
    {
      history: ok(HISTORY_LIST_PAGE_2.body),
      messagesGet: ok({ ...MESSAGE_FULL.body, id: MSG_ID_3, internalDate: 'Thu, 17 Sep 2026 09:14:02 +0300' }),
    },
  ],
  [
    'a message body that is standard base64, not base64url',
    {
      history: ok(HISTORY_LIST_PAGE_2.body),
      messagesGet: ok({
        ...MESSAGE_FULL.body,
        id: MSG_ID_3,
        payload: {
          partId: '', mimeType: 'text/plain', filename: '',
          headers: [], body: { size: 12, data: 'SGks+/DQo=Zm9v' },
        },
      }),
    },
  ],
  ['a 200 whose body is not JSON', { history: { status: 200, body: '<html>hi</html>', contentType: 'text/html' } }],
];

for (const [name, script] of MALFORMED_CASES) {
  test(`${name} is rejected as malformed, never coerced`, async () => {
    const { result } = await sync(script);
    assert.equal(result.failure?.kind, 'malformed_response');
    assert.equal(result.failure?.retryable, false);
    assert.equal(result.nextHistoryId, HISTORY_CURSOR_FRESH, 'a rejected page must not move the cursor');
  });
}

test('a repeated page token terminates instead of looping', async () => {
  // Valid JSON, valid types, infinite loop. Bounded call count is the
  // assertion: a regression shows up as a failure, not as a hanging test.
  const { result, calls } = await sync({
    history: ok(MALFORMED_HISTORY_REPEATING_PAGE_TOKEN.body),
  });

  assert.equal(result.failure?.kind, 'malformed_response');
  assert.ok(calls.filter((call) => call.endpoint === 'history').length <= 3, 'must not loop');
});

test('a cursor stays a string all the way to storage', async () => {
  const { result } = await sync(TWO_PAGE_SCRIPT);
  assert.equal(typeof result.nextHistoryId, 'string');
});

/* ══ The cursor round trip ════════════════════════════════════════ */

test('the historyId round-trips through recordConnectionSync and reads back as the next startHistoryId', async () => {
  // Phase B is the first production caller of `recordConnectionSync`, so this
  // proves the loop closes rather than assuming it.
  const store = new MemoryIntegrationConnectionStore();
  const created = await store.upsert({
    scopeId: 'scope-a',
    identity: { provider: 'google', providerAccountId: 'google-1', providerSpaceId: null, displayName: 'Work' },
    state: 'connected',
    capabilities: ['mail_read'],
    grantedScopes: [GMAIL_SCOPES.read],
    sync: { cursor: HISTORY_CURSOR_FRESH, checkpointAt: NOW },
    credentialRef: { vault: 'kms', keyId: 'gmail-1', version: '1' },
  }, NOW);

  const first = scriptedFetch(TWO_PAGE_SCRIPT);
  const run = await runGmailIncrementalSync(
    createGmailTransport(transportDeps(first.fetchImpl)),
    { connection: created, token: activeToken, now: NOW },
  );
  assert.equal(run.state, 'complete');

  const stored = await recordConnectionSync(
    store,
    created.connectionId,
    { cursor: run.nextHistoryId, checkpointAt: NOW },
    NOW,
  );
  assert.equal(stored?.sync?.cursor, '2418890');
  assert.equal(typeof stored?.sync?.cursor, 'string');

  // Second run: the stored cursor becomes the next request's startHistoryId.
  const second = scriptedFetch({ history: ok(HISTORY_LIST_EMPTY.body) });
  await runGmailIncrementalSync(
    createGmailTransport(transportDeps(second.fetchImpl)),
    { connection: stored!, token: activeToken, now: NOW },
  );
  assert.equal(second.calls[0]?.url.searchParams.get('startHistoryId'), '2418890');
});

test('recordConnectionSync drops errorCode on the round trip', async () => {
  // Recorded rather than fixed: a checkpoint write silently clears whatever
  // error the connection was carrying, which matters the moment a sync
  // succeeds after a failure and nobody wanted the failure forgotten.
  const store = new MemoryIntegrationConnectionStore();
  const created = await store.upsert({
    scopeId: 'scope-a',
    identity: { provider: 'google', providerAccountId: 'google-1', providerSpaceId: null, displayName: 'Work' },
    state: 'connected',
    capabilities: ['mail_read'],
    grantedScopes: [GMAIL_SCOPES.read],
    credentialRef: { vault: 'kms', keyId: 'gmail-1', version: '1' },
    errorCode: 'provider_transport_failure',
  }, NOW);
  assert.equal(created.errorCode, 'provider_transport_failure');

  const stored = await recordConnectionSync(store, created.connectionId, { cursor: 'x', checkpointAt: NOW }, NOW);
  assert.equal(stored?.errorCode, undefined);
});

/* ══ Bounds ═══════════════════════════════════════════════════════ */

test('maxResults is clamped to Googles documented maximum however large the caller asks', async () => {
  const { fetchImpl, calls } = scriptedFetch({ history: ok(HISTORY_LIST_EMPTY.body) });
  const transport = createGmailTransport(transportDeps(fetchImpl));
  await transport.listHistory({
    connectionId: 'int-1',
    startHistoryId: HISTORY_CURSOR_FRESH,
    pageToken: null,
    maxResults: 10_000,
  });

  assert.equal(calls[0].url.searchParams.get('maxResults'), String(GMAIL_MAX_PAGE_SIZE));
  assert.equal(GMAIL_MAX_PAGE_SIZE, 500);
});

test('the per-page message fan-out is capped', async () => {
  const ids = Array.from({ length: 25 }, (_, index) => `msg-${index}`);
  const { fetchImpl, calls } = scriptedFetch({
    history: ok({
      history: ids.map((id) => ({ id: `h-${id}`, messagesAdded: [{ message: { id, threadId: 't' } }] })),
      historyId: '2418890',
    }),
    messagesGet: (id) => ok({ ...MESSAGE_FULL.body, id, historyId: '2418871' }),
  });
  const transport = createGmailTransport(transportDeps(fetchImpl, { maxMessagesPerPage: 5 }));
  const page = await transport.listHistory({
    connectionId: 'int-1', startHistoryId: HISTORY_CURSOR_FRESH, pageToken: null, maxResults: 100,
  });

  assert.equal(page.messages.length, 5);
  assert.equal(calls.filter((call) => call.endpoint === 'messagesGet').length, 5);
});

test('a single message cannot be pulled wholesale', async () => {
  const huge = 'x'.repeat(5_000);
  const { fetchImpl } = scriptedFetch({
    history: ok(HISTORY_LIST_PAGE_2.body),
    messagesGet: ok({
      ...MESSAGE_FULL.body,
      id: MSG_ID_3,
      payload: {
        partId: '', mimeType: 'text/plain', filename: '', headers: [],
        body: { size: huge.length, data: Buffer.from(huge, 'utf8').toString('base64url') },
      },
    }),
  });
  const transport = createGmailTransport(transportDeps(fetchImpl, { maxTextBytes: 64 }));
  const page = await transport.listHistory({
    connectionId: 'int-1', startHistoryId: HISTORY_CURSOR_FRESH, pageToken: null, maxResults: 100,
  });

  assert.equal(Buffer.byteLength(page.messages[0].text, 'utf8'), 64);
});

test('a run stops accumulating once its byte budget is spent', async () => {
  const ids = Array.from({ length: 10 }, (_, index) => `msg-${index}`);
  const body = Buffer.from('y'.repeat(400), 'utf8').toString('base64url');
  const { fetchImpl } = scriptedFetch({
    history: ok({
      history: ids.map((id) => ({ id: `h-${id}`, messagesAdded: [{ message: { id, threadId: 't' } }] })),
      historyId: '2418890',
    }),
    messagesGet: (id) => ok({
      ...MESSAGE_FULL.body, id, historyId: '2418871',
      payload: { partId: '', mimeType: 'text/plain', filename: '', headers: [], body: { size: 400, data: body } },
    }),
  });
  const transport = createGmailTransport(transportDeps(fetchImpl, { maxRunBytes: 800, maxConcurrentGets: 1 }));
  const page = await transport.listHistory({
    connectionId: 'int-1', startHistoryId: HISTORY_CURSOR_FRESH, pageToken: null, maxResults: 100,
  });

  assert.ok(page.messages.length < ids.length, 'the budget must actually stop the run');
  assert.ok(page.messages.length <= 3);
});

test('concurrent message fetches are capped', async () => {
  let inFlight = 0;
  let peak = 0;
  const ids = Array.from({ length: 12 }, (_, index) => `msg-${index}`);
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname.endsWith('/history')) {
      return new Response(JSON.stringify({
        history: ids.map((id) => ({ id: `h-${id}`, messagesAdded: [{ message: { id, threadId: 't' } }] })),
        historyId: '2418890',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    const id = /\/messages\/([^/]+)$/.exec(url.pathname)![1];
    return new Response(JSON.stringify({ ...MESSAGE_FULL.body, id, historyId: '2418871' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const transport = createGmailTransport(transportDeps(fetchImpl, { maxConcurrentGets: 3 }));
  await transport.listHistory({
    connectionId: 'int-1', startHistoryId: HISTORY_CURSOR_FRESH, pageToken: null, maxResults: 100,
  });

  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the cap`);
});

test('the fan-out is paced against the documented per-user quota', async () => {
  // 20 quota units a `messages.get` against 6,000 a minute is 300 a minute,
  // which is one every 200ms. The pacing is asserted as arithmetic against an
  // injected clock rather than by watching a wall clock.
  const slept: number[] = [];
  let clock = 0;
  const { fetchImpl } = scriptedFetch({
    history: ok(HISTORY_LIST_PAGE_1.body),
    messagesGet: messageFor,
  });
  const transport = createGmailTransport(transportDeps(fetchImpl, {
    maxConcurrentGets: 1,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    monotonicMs: () => clock,
  }));
  await transport.listHistory({
    connectionId: 'int-1', startHistoryId: HISTORY_CURSOR_FRESH, pageToken: null, maxResults: 100,
  });

  const pacing = slept.filter((ms) => ms === 200);
  assert.ok(pacing.length >= 1, 'the second get must wait out the quota spacing');
});

test('the run deadline stops a provider that fails retryably forever', async () => {
  let clock = 0;
  const { result, calls } = await sync(
    { history: { status: 503, body: ERROR_500_BACKEND.body } },
    {
      deps: {
        runDeadlineMs: 3_000,
        sleep: async (ms) => { clock += ms; },
        monotonicMs: () => clock,
      },
    },
  );

  // Without the deadline this would be five attempts; the budget cuts it short.
  assert.ok(calls.length < 5, `expected the deadline to cut the retries, got ${calls.length}`);
  assert.equal(result.failure?.retryable, true);
});

/* ══ Scopes ═══════════════════════════════════════════════════════ */

test('a Phase B connection requests the read scope and nothing else', async () => {
  // Asserted on the literal strings, not on a capability flag: the catalogue
  // also knows about compose and send, and a catalogue entry is not a
  // guarantee about what reaches Google's consent screen.
  assert.deepEqual([...GMAIL_PHASE_B_SCOPES], ['https://www.googleapis.com/auth/gmail.readonly']);
  assert.equal(GMAIL_PHASE_B_SCOPES.includes(GMAIL_SCOPES.draft), false);
  assert.equal(GMAIL_PHASE_B_SCOPES.includes(GMAIL_SCOPES.send), false);
  assert.equal(GMAIL_PHASE_B_SCOPES.some((scope) => scope === 'https://mail.google.com/'), false);
});

test('the transport reaches four read endpoints and no other verb', async () => {
  const { calls } = await sync(TWO_PAGE_SCRIPT);
  for (const call of calls) {
    assert.equal(call.url.pathname.startsWith('/gmail/v1/users/me/'), true);
  }
  assert.equal(GMAIL_TRANSPORT_POLICY.readOnly, true);
  assert.equal(GMAIL_TRANSPORT_POLICY.mutatesMailbox, false);
  assert.equal(GMAIL_TRANSPORT_POLICY.touchesCredentialVault, false);
  assert.deepEqual([...GMAIL_TRANSPORT_POLICY.endpoints], [
    'profile.get', 'history.list', 'messages.list', 'messages.get',
  ]);
});

/* ══ The second facade ════════════════════════════════════════════ */

test('the read port serves the one Gmail operation and refuses anything else', async () => {
  const { fetchImpl } = scriptedFetch({
    profile: ok(PROFILE_OK.body),
    messagesList: ok(MESSAGES_LIST_PAGE_1.body),
    messagesGet: messageFor,
  });
  const port = createGmailTransport(transportDeps(fetchImpl)).asReadPort();

  assert.equal(port.provider, 'google');
  const page = await port.read({ operation: 'gmail.history.list', limit: 2 }) as { messages: unknown[] };
  assert.equal(page.messages.length, 2);

  await assert.rejects(
    () => port.read({ operation: 'gmail.messages.send', limit: 1 }),
    /does not serve operation/,
  );
});

test('the read port surfaces an HTTP status the harness can read', async () => {
  // The harness recognises `ProviderProbeHttpError` and nothing else, so a
  // `GmailHttpError` that does not cross the edge becomes an uncategorised
  // failure and the probe reports the wrong thing.
  const { fetchImpl } = scriptedFetch({ profile: { status: 401, body: ERROR_401_INVALID_CREDENTIALS.body } });
  const port = createGmailTransport(transportDeps(fetchImpl)).asReadPort();

  await assert.rejects(
    () => port.read({ operation: 'gmail.history.list', limit: 2 }),
    (error: unknown) => error instanceof ProviderProbeHttpError && error.httpStatus === 401,
  );
});

test('an absent messages array is an empty result, not a crash', async () => {
  // Google omits empty repeated fields. `body.messages.length` throws here,
  // which is the commonest Google-API client bug there is.
  const { fetchImpl } = scriptedFetch({
    profile: ok(PROFILE_OK.body),
    messagesList: ok(MESSAGES_LIST_EMPTY.body),
  });
  const port = createGmailTransport(transportDeps(fetchImpl)).asReadPort();

  const page = await port.read({ operation: 'gmail.history.list', limit: 5 }) as { messages: unknown[] };
  assert.deepEqual(page.messages, []);
});

test('the read port is the same transport, not a second client', async () => {
  const transport = createGmailTransport(transportDeps(scriptedFetch({}).fetchImpl));
  assert.equal(typeof transport.listHistory, 'function');
  assert.equal(typeof transport.asReadPort, 'function');
});

/* ══ Redaction ════════════════════════════════════════════════════ */

/** Everything a leak could carry: the token, and every piece of fixture content. */
const SECRETS: readonly string[] = [
  TOKEN,
  'Bearer ',
  'Practice moved to Thursday',
  'dana@example.org',
  'owner@example.com',
  'Herzliya',
  'ANGjdJ_fixture_attachment_token_0001_do_not_fetch',
];

/**
 * The two surfaces, kept apart on purpose.
 *
 * `carrier` is everything that is *about* the sync — the logger, `console.*`,
 * and any error message or stack. Nothing provider-shaped may appear there.
 *
 * `payload` is the sync result, which carries the normalized message content
 * by design: that content is what the caller asked for, and asserting its
 * absence would be asserting the feature away. What must never appear there is
 * the credential.
 */
async function surfacesOf(script: Script, options: SyncOptions = {}): Promise<{
  carrier: string;
  payload: string;
}> {
  const logs: unknown[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const captured: unknown[] = [];
  const capture = (...args: unknown[]) => { captured.push(args); };
  console.log = capture; console.error = capture; console.warn = capture; console.info = capture;

  let thrown: unknown = null;
  let result: GmailSyncResult | null = null;
  try {
    result = (await sync(script, { ...options, logs })).result;
  } catch (error) {
    thrown = error;
  } finally {
    console.log = original.log; console.error = original.error;
    console.warn = original.warn; console.info = original.info;
  }

  return {
    carrier: JSON.stringify({
      logs,
      captured,
      failure: result?.failure ?? null,
      blockReason: result?.blockReason ?? null,
      thrownMessage: thrown instanceof Error ? thrown.message : String(thrown),
      thrownStack: thrown instanceof Error ? thrown.stack : '',
    }),
    payload: JSON.stringify(result),
  };
}

/** The sweep every redaction test uses. Its own ability to fail is pinned below. */
function assertNoneOf(haystack: string, needles: readonly string[], where: string): void {
  for (const needle of needles) {
    assert.equal(haystack.includes(needle), false, `leaked ${needle} into ${where}`);
  }
}

test('no token and no provider content reaches a log, a console line, or a failure', async () => {
  const { carrier } = await surfacesOf(TWO_PAGE_SCRIPT);
  assertNoneOf(carrier, SECRETS, 'the carrier surface of a successful sync');
});

test('the result carries the message content it was asked for and never the credential', async () => {
  const { payload } = await surfacesOf(TWO_PAGE_SCRIPT);

  // The content is the point of the read, so it is present...
  assert.equal(payload.includes('Practice moved to Thursday'), true);
  // ...and the credential is not, anywhere in it.
  assertNoneOf(payload, [TOKEN, 'Bearer ', 'ANGjdJ_fixture_attachment_token_0001_do_not_fetch'], 'the sync result');
});

test('no token and no provider content escapes any failure path', async () => {
  const failures: readonly (readonly [string, Script])[] = [
    ['401', { history: { status: 401, body: ERROR_401_INVALID_CREDENTIALS.body } }],
    ['403', { history: { status: 403, body: ERROR_403_INSUFFICIENT_SCOPE.body } }],
    ['404 stale cursor', { history: { status: 404, body: ERROR_404_HISTORY_CURSOR_TOO_OLD.body } }],
    ['500', { history: { status: 500, body: ERROR_500_BACKEND.body } }],
    ['502 html', { history: { status: 502, body: ERROR_502_HTML_BODY.body, contentType: 'text/html' } }],
    ['malformed', { history: ok(MALFORMED_HISTORY_NO_HISTORY_ID.body) }],
    [
      'timeout whose own message carries the token',
      { history: { throws: Object.assign(new Error(`connect ETIMEDOUT ${TOKEN}`), { code: 'ETIMEDOUT' }) } },
    ],
    [
      'a 5xx after a page of real messages',
      {
        history: [ok(HISTORY_LIST_PAGE_1.body), { status: 503, body: ERROR_500_BACKEND.body }],
        messagesGet: messageFor,
      },
    ],
  ];

  for (const [name, script] of failures) {
    const { carrier } = await surfacesOf(script);
    assertNoneOf(carrier, SECRETS, `the carrier surface of ${name}`);
  }
});

test('an error message names the endpoint and the status, never the URL or the body', async () => {
  // Asserted as an exact allowed shape rather than by hunting for forbidden
  // substrings. A deny-list over a message is the weaker test — it only ever
  // catches the leak somebody already thought of — and a host substring check
  // is the very pattern CodeQL flags as incomplete URL sanitization.
  const ALLOWED = /^gmail (profile\.get|history\.list|messages\.list|messages\.get) responded \d{3}$/;

  for (const endpoint of ['profile.get', 'history.list', 'messages.list', 'messages.get'] as const) {
    for (const status of [401, 403, 404, 429, 500, 502]) {
      const error = new GmailHttpError(status, endpoint);
      assert.match(error.message, ALLOWED);
      // Fully determined by the code, in the manner of `SafeFetchError`: the
      // same inputs give byte-identical output, so nothing situational — a
      // URL, a host, a body — can have reached it.
      assert.equal(new GmailHttpError(status, endpoint).message, error.message);
    }
  }

  assert.equal(new GmailHttpError(403, 'history.list').message, 'gmail history.list responded 403');

  // The wire error names the field that was wrong and never its value.
  const wire = new GmailWireError('history.list', 'string historyId');
  assert.equal(wire.message, 'gmail history.list response has no readable string historyId');
});

test('a logged request URL carries no token', async () => {
  const { calls } = await sync(TWO_PAGE_SCRIPT);
  for (const call of calls) {
    assert.equal(call.url.toString().includes(TOKEN), false);
    // `pageToken` is a legitimate, opaque query parameter, so this checks for
    // the credential itself rather than for the substring "token".
    call.url.searchParams.forEach((value) => {
      assert.notEqual(value, TOKEN, 'no credential in a query parameter');
    });
    // The token travels in the header, which is where it belongs.
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
  }
});

test('NEGATIVE CONTROL: the redaction sweep fails when a token really is leaked', async () => {
  // Without this the whole redaction suite can pass by asserting nothing.
  // A deliberate leak must turn the assertion red; if this test ever stops
  // throwing, every assertion above it is worthless.
  const leaked = JSON.stringify({ logs: [{ authorization: `Bearer ${TOKEN}` }] });

  // Calls the very same helper the tests above call — not a copy of it.
  assert.throws(
    () => assertNoneOf(leaked, SECRETS, 'a deliberately leaked transcript'),
    /leaked ya29\./,
    'the sweep used by every redaction test above must be able to fail',
  );

  // And the same for provider content, not only the token.
  const contentLeak = JSON.stringify({ logs: [{ subject: 'Practice moved to Thursday' }] });
  assert.throws(
    () => assertNoneOf(contentLeak, SECRETS, 'a deliberately leaked subject line'),
    /leaked Practice moved to Thursday/,
  );

  // And it passes on a clean transcript, so it is not simply always throwing.
  assertNoneOf(JSON.stringify({ logs: [{ errorCode: 'provider_transport_failure' }] }), SECRETS, 'a clean transcript');
});
