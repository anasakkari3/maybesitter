/**
 * The Gmail production read transport (Phase B).
 *
 * This is the first object in the repository that can actually talk to a
 * provider. It sits *below* `GmailApiPort` and implements its single verb,
 * `listHistory`. Everything above it already exists and is not re-implemented
 * here: `runGmailIncrementalSync` owns the page loop, the page cap, the size
 * clamp, the repeated-page-token guard, dedupe, cursor-advance-only-on-complete,
 * failure classification and safe logging.
 *
 * ── The fact that shapes this whole file ─────────────────────────
 *
 * `users.history.list` returns message **stubs** — id, threadId, labelIds and
 * nothing else. It carries no headers, no `internalDate` and no body, so it can
 * never populate `GmailMessagePayload.from`, `subject`, `text` or `receivedAt`.
 * (CONTRACT.md §3.1, from Google's users.history.list reference and sync guide.)
 * Anyone wiring `history.list` straight into the port produces empty or
 * fabricated fields. So one call to `listHistory` is really
 * `history.list` → collect ids → `messages.get` per id → assemble.
 *
 * That fan-out is invisible from the port and it is expensive: `history.list`
 * costs 2 quota units, each `messages.get` costs 20, against 6,000 units per
 * user per minute (CONTRACT.md §7). Roughly 300 gets a minute is the ceiling,
 * which is why the bounds below are counted in messages and units, not pages.
 *
 * ── Read only, structurally ──────────────────────────────────────
 *
 * Four GET endpoints, no other verb anywhere in this file: `users.getProfile`,
 * `users.history.list`, `users.messages.list`, `users.messages.get`. Nothing
 * sends, drafts, labels, archives, deletes or changes read state. Attachment
 * bytes are never fetched — an attachment part is skipped, and
 * `users.messages.attachments.get` is not reachable from here.
 *
 * ── Errors carry a code, never the wire ──────────────────────────
 *
 * The precedent is `SafeFetchError` (lib/net/safeFetch.ts): a fixed message per
 * code, never the URL. Nothing in this file puts a response body, a URL, a
 * host, a header or a token into an error message, and
 * `tests/llm/promptBoundary.test.ts` exists to prove provider content never
 * escapes into a prompt. One internal error type carries the HTTP status
 * inward, and it is translated at each edge: to `GmailProviderError` for the
 * port, and to `ProviderProbeHttpError` for the verification harness, which
 * recognises only the latter.
 */
import {
  GmailProviderError,
  gmailScopesForCapabilities,
  type GmailApiPort,
  type GmailHistoryPage,
  type GmailHistoryRequest,
  type GmailMessagePayload,
} from '../adapter';
import {
  isProviderTransportFailure,
  type ProviderFailureInput,
} from '../../providers/providerRuntime';
import {
  ProviderProbeHttpError,
  type ProviderReadPort,
} from '../../../verification/liveProviderVerification';

/* ── Bounds. Every read is finite. ─────────────────────────────── */

export const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com/gmail/v1';

/** One request. Not a whole sync — `GMAIL_RUN_DEADLINE_MS` bounds that. */
export const GMAIL_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A ceiling on one `listHistory` call, so N retryable requests cannot multiply
 * into an unbounded run even though each one is individually bounded.
 */
export const GMAIL_RUN_DEADLINE_MS = 120_000;

/** Documented maximum for both list endpoints (CONTRACT.md §3, §4.1). */
export const GMAIL_MAX_PAGE_SIZE = 500;

/**
 * How many `messages.get` calls one page may trigger.
 *
 * 100 gets is 2,000 quota units — a third of a mailbox's minute — and at the
 * adapter's default of 10 pages a single sync already reaches the ceiling. The
 * page loop above will stop at `maxPages` regardless; this stops one
 * pathologically large page from spending the whole budget by itself.
 */
export const GMAIL_MAX_MESSAGES_PER_PAGE = 100;

/** Bytes of decoded text kept per message. A mail is not a file transfer. */
export const GMAIL_MAX_TEXT_BYTES = 262_144;

/** Total decoded bytes one `listHistory` call will accumulate. */
export const GMAIL_MAX_RUN_BYTES = 8 * 1_048_576;

/** How many `messages.get` calls may be in flight at once (CONTRACT.md §7). */
export const GMAIL_MAX_CONCURRENT_GETS = 4;

/** Retries per request, on 429/5xx and on a call that never completed. */
export const GMAIL_MAX_RETRIES = 4;

/** `min(2^n + jitter, maximum_backoff)`; Google documents 32–64s (CONTRACT.md §7). */
export const GMAIL_MAX_BACKOFF_MS = 32_000;
export const GMAIL_BACKOFF_BASE_MS = 1_000;
export const GMAIL_JITTER_MAX_MS = 1_000;

/** Quota units per call, and the per-user ceiling (CONTRACT.md §7). */
export const GMAIL_QUOTA_UNITS = Object.freeze({
  'profile.get': 1,
  'history.list': 2,
  'messages.list': 5,
  'messages.get': 20,
} as const);
export const GMAIL_QUOTA_UNITS_PER_MINUTE = 6_000;

export type GmailEndpoint = keyof typeof GMAIL_QUOTA_UNITS;

/* ── Errors ────────────────────────────────────────────────────── */

/**
 * A non-2xx from Gmail, carrying the status and which call produced it.
 *
 * `endpoint` is one of four fixed literals and `httpStatus` is a number, so the
 * message is fully determined by the code — there is no path by which a URL, a
 * body or a token reaches it.
 */
export class GmailHttpError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly endpoint: GmailEndpoint,
  ) {
    super(`gmail ${endpoint} responded ${httpStatus}`);
    this.name = 'GmailHttpError';
  }
}

/**
 * A 2xx whose body does not match the documented shape.
 *
 * `field` names the field that was wrong; the value is never included, because
 * the value is provider content.
 */
export class GmailWireError extends Error {
  constructor(
    readonly endpoint: GmailEndpoint,
    readonly field: string,
  ) {
    super(`gmail ${endpoint} response has no readable ${field}`);
    this.name = 'GmailWireError';
  }
}

/* ── Wire shapes, as documented ────────────────────────────────── */

interface WireBody {
  attachmentId?: unknown;
  size?: unknown;
  data?: unknown;
}
interface WirePart {
  mimeType?: unknown;
  filename?: unknown;
  headers?: unknown;
  body?: WireBody;
  parts?: unknown;
}
interface WireMessage {
  id?: unknown;
  threadId?: unknown;
  historyId?: unknown;
  internalDate?: unknown;
  payload?: WirePart;
}

/* ── Dependencies ──────────────────────────────────────────────── */

export interface GmailTransportDeps {
  /**
   * Produces a bearer token. The transport never touches the credential vault:
   * see `lib/integrations/providers/production/providerAccessToken.ts` for why
   * a transport must not hold a refresh token, and why this cannot be cached
   * across accounts.
   */
  readonly accessToken: () => Promise<string>;
  /**
   * Forces a token refresh and returns the new bearer, for the one case a
   * proactive check cannot cover.
   *
   * `providerTokenState` decides refreshes from the expiry the grant *claims*.
   * Google documents no access-token lifetime (CONTRACT.md §9.10) and a token
   * can also be invalidated early — a password change is the ordinary case
   * (§8.4) — so a 401 can arrive while the stored metadata still says
   * `active`. D10 prescribes exactly one reaction: refresh, then retry once.
   *
   * Optional. A transport built without it simply reports the 401, which is
   * what the live-verification harness wants: it is handed a bare token and
   * has no grant to refresh.
   */
  readonly reauth?: () => Promise<string>;
  /** Defaults to the global `fetch`. Injected by every test in this suite. */
  readonly fetchImpl?: typeof fetch;
  /** Injected the way `footballDataProvider` injects it, and for the same reason. */
  readonly env?: { GMAIL_API_BASE_URL?: string };
  readonly timeoutMs?: number;
  readonly runDeadlineMs?: number;
  readonly maxMessagesPerPage?: number;
  readonly maxTextBytes?: number;
  readonly maxRunBytes?: number;
  readonly maxConcurrentGets?: number;
  readonly maxRetries?: number;
  /** Injected so the backoff schedule can be asserted exactly rather than observed. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected so jitter is provably present and provably varies. */
  readonly random?: () => number;
  /** Monotonic milliseconds, for the run deadline and for quota pacing. */
  readonly monotonicMs?: () => number;
}

export interface GmailTransport extends GmailApiPort {
  /**
   * The same object, wearing the face the live-verification harness expects.
   *
   * Deliberately a facade and not a second client: a client written for
   * verification would not be the client production uses, and then a green run
   * would mean nothing.
   */
  asReadPort(): ProviderReadPort;
}

/* ── Helpers ───────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** Base64url per RFC 4648 §5, unpadded, as Gmail emits it (CONTRACT.md §4.3). */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * Decodes a base64url body part.
 *
 * Rejects rather than guesses. A standard-base64 decode of a base64url string
 * silently corrupts any byte that happened to encode as `-` or `_`, so a
 * payload carrying `+`, `/` or embedded `=` is a contract violation and is
 * reported as one instead of producing plausible-looking wrong text.
 */
export function decodeBase64Url(data: string, endpoint: GmailEndpoint): string {
  if (!BASE64URL.test(data)) throw new GmailWireError(endpoint, 'base64url body data');
  return Buffer.from(data, 'base64url').toString('utf8');
}

function headerValue(headers: unknown, name: string): string | null {
  if (!Array.isArray(headers)) return null;
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if (!isRecord(header)) continue;
    if (typeof header.name === 'string' && header.name.toLowerCase() === wanted) {
      return typeof header.value === 'string' ? header.value : null;
    }
  }
  return null;
}

/**
 * Picks the text of a message, preferring `text/plain` over `text/html`.
 *
 * For a `multipart/*` message the top-level `payload.body` is an empty
 * container and the text lives in `payload.parts[*].body.data`; a client that
 * reads only the top-level body gets nothing back for the commonest message
 * shape there is. An attachment part has no `data` and an `attachmentId`
 * instead — it is skipped, and its bytes are never fetched.
 */
function selectText(payload: WirePart | undefined, endpoint: GmailEndpoint): string {
  if (!payload) return '';
  const plain: string[] = [];
  const html: string[] = [];

  const walk = (part: WirePart, depth: number): void => {
    if (depth > 12) return;
    const mime = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
    const body = part.body;
    const data = body && typeof body.data === 'string' ? body.data : null;
    const isAttachment =
      (body && typeof body.attachmentId === 'string' && body.attachmentId !== '') ||
      nonEmptyString(part.filename);
    if (data !== null && !isAttachment) {
      if (mime.startsWith('text/plain')) plain.push(decodeBase64Url(data, endpoint));
      else if (mime.startsWith('text/html')) html.push(decodeBase64Url(data, endpoint));
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) if (isRecord(child)) walk(child as WirePart, depth + 1);
    }
  };

  walk(payload, 0);
  return (plain.length > 0 ? plain : html).join('\n');
}

/** Truncates on a byte budget without splitting a UTF-8 sequence. */
function clampBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  return new TextDecoder('utf8', { fatal: false }).decode(buffer.subarray(0, maxBytes)).replace(/�+$/, '');
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(Number.isFinite(value) ? Math.floor(value) : min, max));

/**
 * Truncated exponential backoff with jitter, per Google's guidance
 * (CONTRACT.md §7): `min(2^n * base + random(0..1000ms), maximum_backoff)`.
 *
 * The jitter is not decoration — it is what stops every client that was
 * throttled at the same moment retrying in the same wave.
 */
export function gmailBackoffMs(attempt: number, random: () => number): number {
  const exponential = GMAIL_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * GMAIL_JITTER_MAX_MS);
  return Math.min(GMAIL_MAX_BACKOFF_MS, exponential + jitter);
}

/** 429 and 5xx are the retryable statuses Google documents (CONTRACT.md §7). */
const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/* ── The transport ─────────────────────────────────────────────── */

export function createGmailTransport(deps: GmailTransportDeps): GmailTransport {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const baseUrl = env.GMAIL_API_BASE_URL ?? GMAIL_API_BASE_URL;
  const timeoutMs = deps.timeoutMs ?? GMAIL_REQUEST_TIMEOUT_MS;
  const runDeadlineMs = deps.runDeadlineMs ?? GMAIL_RUN_DEADLINE_MS;
  const maxMessagesPerPage = deps.maxMessagesPerPage ?? GMAIL_MAX_MESSAGES_PER_PAGE;
  const maxTextBytes = deps.maxTextBytes ?? GMAIL_MAX_TEXT_BYTES;
  const maxRunBytes = deps.maxRunBytes ?? GMAIL_MAX_RUN_BYTES;
  const maxConcurrentGets = deps.maxConcurrentGets ?? GMAIL_MAX_CONCURRENT_GETS;
  const maxRetries = deps.maxRetries ?? GMAIL_MAX_RETRIES;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const monotonicMs = deps.monotonicMs ?? (() => Date.now());

  /** One HTTP GET: token, timeout, abort, status check, JSON parse. */
  async function getOnce(endpoint: GmailEndpoint, url: URL): Promise<unknown> {
    const token = await deps.accessToken();

    // Not `AbortSignal.timeout`: its timer does not hold the event loop open,
    // so a process whose only pending work is this request can exit before the
    // abort fires and the read ends silently instead of recording a timeout.
    // The same reasoning, and the same shape, as `footballDataProvider`.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException(`gmail ${endpoint} request timed out`, 'TimeoutError')),
      timeoutMs,
    );

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // A non-2xx throws rather than degrading to an empty page. An empty page
    // here is indistinguishable from "nothing new in this mailbox", and the
    // sync above would read that as licence to advance the cursor past mail it
    // never saw.
    if (!response.ok) throw new GmailHttpError(response.status, endpoint);

    // Not every non-2xx carries JSON and not every 2xx does either — a proxy
    // or Google's front end can return HTML. Parsing is guarded so a bad body
    // surfaces as a contract violation rather than as a parse error thrown
    // from inside the error path.
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new GmailWireError(endpoint, 'JSON body');
    }
    return parsed;
  }

  /**
   * One HTTP GET with the documented retry policy.
   *
   * Retries 429, 5xx and a call that never completed; never retries 403, 404
   * or a contract violation, because none of those get better by being asked
   * again. A 401 is the exception that is not a backoff case: D10 says refresh
   * the token and retry **once**, so it is handled separately and does not
   * consume the backoff budget. A second 401 after a fresh token means the
   * grant is genuinely gone, and it is reported rather than retried.
   */
  async function get(endpoint: GmailEndpoint, url: URL, startedAt: number): Promise<unknown> {
    let lastError: unknown;
    let reauthed = false;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      try {
        return await getOnce(endpoint, url);
      } catch (error) {
        lastError = error;

        if (
          error instanceof GmailHttpError &&
          error.httpStatus === 401 &&
          deps.reauth !== undefined &&
          !reauthed
        ) {
          reauthed = true;
          await deps.reauth();
          // No delay and no attempt consumed: the condition has already been
          // corrected, so waiting would only slow down a request that is now
          // expected to succeed.
          attempt -= 1;
          continue;
        }

        const retryableHttp = error instanceof GmailHttpError && isRetryableStatus(error.httpStatus);
        // A timeout or a reset socket is the textbook retryable failure, and
        // since #517 it has a truthful home in the taxonomy too.
        const retryableTransport = isProviderTransportFailure(error);
        if (!retryableHttp && !retryableTransport) throw error;
        if (attempt > maxRetries) throw error;

        const delay = gmailBackoffMs(attempt, random);
        // The per-request timeout bounds one call; this bounds the whole
        // sequence, so a provider that is slow rather than down cannot keep a
        // sync alive indefinitely by failing retryably forever.
        if (monotonicMs() - startedAt + delay > runDeadlineMs) throw error;
        await sleep(delay);
      }
    }
    throw lastError;
  }

  /** Pacing: 20 units a `messages.get` against 6,000 a minute is ~300/minute. */
  const minGetSpacingMs = Math.ceil(
    60_000 / (GMAIL_QUOTA_UNITS_PER_MINUTE / GMAIL_QUOTA_UNITS['messages.get']),
  );

  function url(path: string, params: Record<string, string | number | undefined> = {}): URL {
    const built = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) built.searchParams.set(key, String(value));
    }
    return built;
  }

  /** `users.getProfile` — 1 quota unit, and the documented cursor baseline. */
  async function getProfileHistoryId(startedAt: number): Promise<string> {
    const body = await get('profile.get', url('/users/me/profile'), startedAt);
    if (!isRecord(body)) throw new GmailWireError('profile.get', 'object body');
    if (!nonEmptyString(body.historyId)) throw new GmailWireError('profile.get', 'string historyId');
    return body.historyId;
  }

  /** `users.messages.get?format=full` → one normalized `GmailMessagePayload`. */
  async function getMessage(id: string, startedAt: number): Promise<GmailMessagePayload | null> {
    let body: unknown;
    try {
      // `format` is passed explicitly on every call: Google does not document
      // a default (CONTRACT.md §9.4), so relying on one is relying on nothing.
      body = await get('messages.get', url(`/users/me/messages/${encodeURIComponent(id)}`, { format: 'full' }), startedAt);
    } catch (error) {
      // A message that vanished between the history walk and the fetch is
      // ordinary — the user deleted it. Skipping it is correct and is why this
      // transport needs no `not_found` failure kind: the caller knows which
      // call it made, so it resolves the ambiguity a bare 404 cannot.
      if (error instanceof GmailHttpError && error.httpStatus === 404) return null;
      throw error;
    }

    if (!isRecord(body)) throw new GmailWireError('messages.get', 'object body');
    const message = body as WireMessage;
    if (!nonEmptyString(message.id)) throw new GmailWireError('messages.get', 'string id');
    if (!nonEmptyString(message.historyId)) throw new GmailWireError('messages.get', 'string historyId');
    // Epoch milliseconds as a decimal string. An RFC 2822 date here is a
    // contract violation, not something to coerce — `new Date(...)` would
    // happily accept it and quietly change what "received" means.
    if (typeof message.internalDate !== 'string' || !/^\d+$/.test(message.internalDate)) {
      throw new GmailWireError('messages.get', 'epoch-millisecond internalDate');
    }
    const receivedAtMs = Number(message.internalDate);
    if (!Number.isFinite(receivedAtMs)) throw new GmailWireError('messages.get', 'epoch-millisecond internalDate');

    const headers = message.payload?.headers;
    return Object.freeze({
      id: message.id,
      threadId: nonEmptyString(message.threadId) ? message.threadId : null,
      historyId: message.historyId,
      receivedAt: new Date(receivedAtMs).toISOString(),
      from: headerValue(headers, 'From'),
      subject: headerValue(headers, 'Subject'),
      text: clampBytes(selectText(message.payload, 'messages.get'), maxTextBytes),
    });
  }

  /** Bounded, concurrency-capped, quota-paced fan-out over message ids. */
  async function fetchMessages(ids: readonly string[], startedAt: number): Promise<GmailMessagePayload[]> {
    const out: GmailMessagePayload[] = [];
    let bytes = 0;
    let cursor = 0;
    let lastGetAt = -Infinity;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= ids.length) return;
        if (bytes >= maxRunBytes) return;

        const since = monotonicMs() - lastGetAt;
        if (since < minGetSpacingMs) await sleep(minGetSpacingMs - since);
        lastGetAt = monotonicMs();

        const message = await getMessage(ids[index], startedAt);
        if (!message) continue;
        bytes += Buffer.byteLength(message.text, 'utf8');
        out.push(message);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(maxConcurrentGets, Math.max(1, ids.length)) }, worker),
    );
    // Deterministic order regardless of which worker finished first; the
    // adapter dedupes by key, but a stable order keeps results reproducible.
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** The port's one verb. */
  async function listHistory(request: GmailHistoryRequest): Promise<GmailHistoryPage> {
    const startedAt = monotonicMs();
    try {
      // `startHistoryId` is a *required* parameter of `history.list`, so a
      // connection with no cursor cannot call it at all. The documented
      // baseline is `getProfile.historyId`, "the mailbox's current history
      // record" — one quota unit. Taking it means the first sync starts from
      // now and ingests nothing, which is the deliberate choice: the
      // alternative, D8's full-sync backfill, would pull an entire mailbox on
      // connect. See the report note; this is a product decision as much as a
      // technical one.
      if (!nonEmptyString(request.startHistoryId)) {
        return Object.freeze({
          historyId: await getProfileHistoryId(startedAt),
          messages: Object.freeze([]),
          nextPageToken: null,
        });
      }

      const body = await get(
        'history.list',
        url('/users/me/history', {
          startHistoryId: request.startHistoryId,
          // Clamped to Google's documented maximum however large a caller asks.
          maxResults: clamp(request.maxResults, 1, GMAIL_MAX_PAGE_SIZE),
          // Read-only: the only change worth ingesting is a new message.
          historyTypes: 'messageAdded',
          pageToken: request.pageToken ?? undefined,
        }),
        startedAt,
      );

      if (!isRecord(body)) throw new GmailWireError('history.list', 'object body');
      // A cursor is a string end to end. Gmail ids are 64-bit and a number
      // here would silently lose precision on a large mailbox.
      if (!nonEmptyString(body.historyId)) throw new GmailWireError('history.list', 'string historyId');

      const ids: string[] = [];
      const seen = new Set<string>();
      const records = body.history;
      if (records !== undefined && !Array.isArray(records)) {
        throw new GmailWireError('history.list', 'history array');
      }
      for (const record of records ?? []) {
        if (!isRecord(record)) continue;
        // `messagesAdded` only. `labelsAdded`, `labelsRemoved` and
        // `messagesDeleted` are mailbox churn a read-only ingest must ignore —
        // reacting to them would turn a label change into an ingested item.
        const added = record.messagesAdded;
        if (added === undefined) continue;
        if (!Array.isArray(added)) throw new GmailWireError('history.list', 'messagesAdded array');
        for (const entry of added) {
          if (!isRecord(entry) || !isRecord(entry.message)) continue;
          const id = entry.message.id;
          if (!nonEmptyString(id) || seen.has(id)) continue;
          seen.add(id);
          if (ids.length < maxMessagesPerPage) ids.push(id);
        }
      }

      return Object.freeze({
        historyId: body.historyId,
        messages: Object.freeze(await fetchMessages(ids, startedAt)),
        nextPageToken: nonEmptyString(body.nextPageToken) ? body.nextPageToken : null,
      });
    } catch (error) {
      throw toGmailProviderError(error);
    }
  }

  /**
   * A bounded sample of recent messages, for the verification probe only.
   *
   * The probe needs real messages to push through the production normalizer,
   * and a history walk from the mailbox's current cursor returns nothing by
   * definition. `messages.list` + `messages.get` is Google's own full-sync
   * procedure and is the same code path, the same parser and the same bounds
   * as the port above — not a second client.
   */
  async function sampleRecentMessages(limit: number): Promise<GmailHistoryPage> {
    const startedAt = monotonicMs();
    const historyId = await getProfileHistoryId(startedAt);
    const body = await get(
      'messages.list',
      url('/users/me/messages', { maxResults: clamp(limit, 1, GMAIL_MAX_PAGE_SIZE) }),
      startedAt,
    );
    if (!isRecord(body)) throw new GmailWireError('messages.list', 'object body');
    const listed = body.messages;
    // Absent, not `[]`, is how Google reports an empty repeated field. Reading
    // `body.messages.length` here is the commonest Google-API client bug there
    // is, so absence is a valid empty result and only a wrong *type* is an error.
    if (listed !== undefined && !Array.isArray(listed)) {
      throw new GmailWireError('messages.list', 'messages array');
    }
    const ids: string[] = [];
    for (const entry of listed ?? []) {
      if (isRecord(entry) && nonEmptyString(entry.id) && ids.length < maxMessagesPerPage) {
        ids.push(entry.id);
      }
    }
    return Object.freeze({
      historyId,
      messages: Object.freeze(await fetchMessages(ids, startedAt)),
      nextPageToken: null,
    });
  }

  return {
    listHistory,

    asReadPort(): ProviderReadPort {
      return {
        provider: 'google',
        async read(request) {
          // One operation. The facade refuses anything else rather than
          // quietly doing a history walk for a name it does not recognise.
          if (request.operation !== 'gmail.history.list') {
            throw new Error(`gmail read port does not serve operation ${JSON.stringify(request.operation)}`);
          }
          try {
            return await sampleRecentMessages(request.limit);
          } catch (error) {
            // The harness recognises `ProviderProbeHttpError` and nothing
            // else, so the status is carried across the edge here rather than
            // teaching the harness a second error type.
            throw toProbeError(error);
          }
        },
      };
    },
  };
}

/* ── Edge translations ─────────────────────────────────────────── */

/**
 * Wire error → the error the port's caller classifies.
 *
 * A timeout or a reset socket is deliberately **passed through unchanged**:
 * `runGmailIncrementalSync` recognises it via `isProviderTransportFailure` and
 * classifies it as `transport_failure` (retryable, connection stays
 * `connected`). Wrapping it in a `GmailProviderError` would erase the shape the
 * detector reads and put us back where #517 started.
 */
export function toGmailProviderError(error: unknown): unknown {
  if (error instanceof GmailProviderError) return error;
  if (isProviderTransportFailure(error)) return error;

  if (error instanceof GmailWireError) {
    return new GmailProviderError(error.message, null, false, true);
  }

  if (error instanceof GmailHttpError) {
    // A stale `startHistoryId` is HTTP **404** and Google documents only the
    // status, never a body (CONTRACT.md §3.2). It is asserted here, by the
    // caller that knows which call it made, rather than guessed by the
    // classifier from a status that is ambiguous on its own — and never from a
    // `reason` string, which is undocumented and may change.
    const staleCursor = error.endpoint === 'history.list' && error.httpStatus === 404;
    // NOTE: Gmail signals rate limiting with 403 (`rateLimitExceeded`,
    // `userRateLimitExceeded`) as often as with 429, and the classifier maps
    // every 403 to `permission_lost` (CONTRACT.md §7). Distinguishing them
    // needs the response *body*, which `ProviderFailureInput` cannot carry
    // today — that is a separate change, tracked out of #517, and the
    // normalized reason would be asserted here, on this line.
    return new GmailProviderError(error.message, error.httpStatus, staleCursor, false);
  }

  return error;
}

/** Wire error → the only error type the live-verification harness reads. */
export function toProbeError(error: unknown): unknown {
  if (error instanceof GmailHttpError) {
    return new ProviderProbeHttpError(error.httpStatus, error.message);
  }
  if (error instanceof GmailProviderError && typeof error.status === 'number') {
    return new ProviderProbeHttpError(error.status, error.message);
  }
  return error;
}

/**
 * The scopes a Phase B connection may request.
 *
 * Derived from the capability rather than written out, so it cannot drift from
 * what `planProviderSync` will demand. `mail_read` yields exactly
 * `gmail.readonly` — never `gmail.compose`, never `gmail.send`, never
 * `https://mail.google.com/`, all three of which the catalogue also knows
 * about. `gmail.metadata` would be narrower still but cannot return bodies,
 * and `GmailMessagePayload.text` requires them (CONTRACT.md §1.2).
 */
export const GMAIL_PHASE_B_SCOPES: readonly string[] = gmailScopesForCapabilities(['mail_read']);

/** Documented for the reader: what this transport can produce, and never does. */
export const GMAIL_TRANSPORT_POLICY = Object.freeze({
  readOnly: true,
  endpoints: Object.freeze(['profile.get', 'history.list', 'messages.list', 'messages.get'] as const),
  fetchesAttachmentBytes: false,
  mutatesMailbox: false,
  touchesCredentialVault: false,
  classifiesOnResponseBody: false,
} satisfies Record<string, unknown>);

/** Re-exported for tests that assert the classifier input this transport implies. */
export type { ProviderFailureInput };
