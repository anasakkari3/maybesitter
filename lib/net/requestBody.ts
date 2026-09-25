/**
 * Reading a request body without first holding all of it.
 *
 * Every mobile route used to call `request.json()`, which buffers the whole
 * body into a string and then an object before any length rule can run. The
 * rules that do exist (#508's capture cap, #513, the profile-import 413) are
 * character counts on fields of the parsed object, so they sit *after* the
 * allocation they would need to prevent. Production is one Cloud Run service
 * (`http1`, request ceiling 32 MiB, `--memory=1Gi`, `--concurrency=40`,
 * maxScale 3), so forty concurrent 30 MiB JSON bodies on any authenticated
 * route put more than 1.2 GB of strings plus parsed objects on one instance,
 * which is killed, together with every other user's in-flight request on it.
 * Authentication runs before the body read on every route, so this is an
 * authenticated denial of service with sign-up open, not an anonymous one.
 *
 * ── The contract ─────────────────────────────────────────────────
 *
 *  1. A `Content-Length` over the limit is refused before a byte is read.
 *  2. Otherwise the body is streamed with a byte counter and cancelled the
 *     moment the count passes the limit — a lying or absent `Content-Length`
 *     does not get past this, and at most `limit + one chunk` bytes are ever
 *     held.
 *  3. Only then is the text parsed. A parse failure surfaces as the same
 *     `SyntaxError` `request.json()` throws, so every route's existing 400
 *     mapping is unchanged; only `RequestBodyTooLargeError` is new, and a
 *     route must let it through to `requestBodyTooLargeResponse` rather than
 *     swallow it into its 400 (`tests/security/requestBodyBounds.test.ts`
 *     checks that lexically).
 *
 * `DEFAULT_BODY_LIMIT_BYTES` is 256 KiB. The largest legitimate JSON payload
 * any mobile route accepts is the profile import at `MAX_IMPORT_LENGTH`
 * (4,000 characters, at most 16 KB in UTF-8 before JSON escaping); a capture
 * is 2,000 characters (#508), a memory fact 200, and everything else is a few
 * ids and enums. 256 KiB is over sixteen times the biggest of those, so no
 * real client can hit it, while forty of them at once cost 10 MiB, not a
 * gigabyte. A route that genuinely needs more passes `limitBytes` itself.
 *
 * `lib/earlyAccess/service.ts` had the streaming counter first (4 KiB, for the
 * public landing form) and now calls this module, so there is one reader.
 */

/** The bound every mobile JSON route reads under unless it says otherwise. */
export const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;

export interface ReadBodyOptions {
  /** The most bytes this read will hold. Defaults to `DEFAULT_BODY_LIMIT_BYTES`. */
  limitBytes?: number;
}

/**
 * The body was larger than the route accepts.
 *
 * `declared` says whether the refusal came from the `Content-Length` header
 * (nothing was read) or from the byte counter (the stream was cancelled at
 * `limit + one chunk`). Both answer the same 413.
 */
export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number;
  readonly declared: boolean;

  constructor(maxBytes: number, declared: boolean) {
    super(`the request body may be at most ${maxBytes} bytes`);
    this.name = 'RequestBodyTooLargeError';
    this.maxBytes = maxBytes;
    this.declared = declared;
  }
}

function limitOf(options: ReadBodyOptions | undefined): number {
  const limit = options?.limitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('limitBytes must be a non-negative integer');
  return limit;
}

/**
 * True when the request declares a body over the limit.
 *
 * Only a parseable, finite header counts. A missing or malformed header is
 * "unknown", and unknown is what the byte counter is for.
 */
export function declaredBodyTooLarge(request: Request, limitBytes: number): boolean {
  const raw = request.headers.get('content-length');
  if (!raw) return false;
  const length = Number.parseInt(raw, 10);
  return Number.isFinite(length) && length > limitBytes;
}

/**
 * The raw body, held only up to the limit.
 *
 * Refuses on `Content-Length` first (no read), then streams with a counter and
 * cancels the reader as soon as the count passes the limit. A request with no
 * body (`request.body === null`) reads as zero bytes, which is what
 * `request.text()` answers for the same request.
 */
export async function readBoundedBytes(request: Request, options?: ReadBodyOptions): Promise<Uint8Array<ArrayBuffer>> {
  const limit = limitOf(options);
  if (declaredBodyTooLarge(request, limit)) throw new RequestBodyTooLargeError(limit, true);

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) {
        // Cancel before throwing: the source stops being pulled, and the
        // chunks already held are the most this request will ever cost.
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError(limit, false);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  // Always a fresh ArrayBuffer-backed array: a reader chunk may be a view over
  // a larger buffer, and `Response` needs a plain one.
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/**
 * The body as text, bounded. UTF-8 with the BOM stripped, which is what
 * `request.text()` does.
 */
export async function readBoundedText(request: Request, options?: ReadBodyOptions): Promise<string> {
  const bytes = await readBoundedBytes(request, options);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * `request.json()`, bounded.
 *
 * Throws `RequestBodyTooLargeError` for an over-sized body and the same
 * `SyntaxError` `JSON.parse` throws for anything that is not JSON — including
 * an empty body, exactly as `request.json()` did — so a route's existing
 * `catch` keeps its 400 for the second and needs one line for the first.
 */
export async function readJsonBody<T = unknown>(request: Request, options?: ReadBodyOptions): Promise<T> {
  const text = await readBoundedText(request, options);
  return JSON.parse(text) as T;
}

/**
 * The one 413 every route answers for an over-sized body.
 *
 * `reason: 'payload_too_large'` is the code `lib/earlyAccess/service.ts`
 * already mints for the same refusal. `mobile/src/api/client.ts` turns any 413
 * into `InputTooLargeError`, reading `maxCharacters` when present; this body
 * has none, because the bound is on bytes, so the client falls back to its
 * generic "too long" copy — the same thing the share route's `file_too_large`
 * already produces.
 */
export function requestBodyTooLargeResponse(error: RequestBodyTooLargeError): Response {
  return Response.json(
    { success: false, error: error.message, reason: 'payload_too_large', maxBytes: error.maxBytes },
    { status: 413 },
  );
}
