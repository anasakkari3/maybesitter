/**
 * Fetching a URL somebody else chose (UC-3.4, #188).
 *
 * A calendar feed is the one place in this product where a user decides what
 * the server connects to. That is server-side request forgery territory: on
 * Cloud Run the prize is the metadata server at 169.254.169.254, which hands
 * the service account's token to anything asking from inside, and after it
 * whatever else is reachable on the VPC. Every rule below exists to keep a
 * pasted URL from being a way to ask the server to fetch one of those.
 *
 * ── The rules, in the order they bite ───────────────────────────
 *
 * 1. **The URL on its face.** Parsed by WHATWG `URL`, never a regex, because
 *    `https://2130706433/` and `https://0x7f.1/` *are* 127.0.0.1 and only the
 *    real parser says so. `webcal:` is read as `https:`; anything else that is
 *    not `https:` is refused. The port must be 443. Userinfo is refused (a URL
 *    carrying a password is not a public calendar, and `https://good@evil` is a
 *    phishing shape). IP literals are checked against the address rule
 *    immediately; `localhost`, `metadata`, `*.internal`, `*.local`,
 *    `*.localhost` and single-label names are refused as hosts.
 *
 * 2. **Every address DNS answers.** Validated *inside the socket's `lookup`
 *    hook*, so the address checked is the address connected to — there is no
 *    second resolution for a rebinding DNS server to answer differently. Every
 *    address in the answer must be global unicast by `ipaddr.js`, after an
 *    IPv4-mapped IPv6 address has been unwrapped; one private address among
 *    public ones refuses the whole answer rather than picking the good one,
 *    because "which one did it pick" is not a question a guard should have.
 *
 * 3. **Redirects** are followed by hand, at most three, and every `Location` is
 *    put through rules 1 and 2 again from scratch. The conditional headers are
 *    sent only to the first hop.
 *
 * 4. **Size and time.** `Content-Length` over the cap is refused before a byte
 *    of body is read; a body without one is counted as it streams and dropped
 *    the moment it passes the cap. One deadline covers the whole chain —
 *    connect, every redirect and the body — so a server trickling a byte a
 *    second cannot hold a worker.
 *
 * 5. **Content type.** `text/calendar`, or `text/plain` / octet-stream / none
 *    only when the body opens with `BEGIN:VCALENDAR`. A compressed body is
 *    refused rather than inflated: we do not ask for compression, and a gzip
 *    bomb is a size cap evaded.
 *
 * ── What this never does ─────────────────────────────────────────
 *
 * It never logs, and no error it throws contains the URL, the host or the
 * response body. A Moodle export URL carries `authtoken=`: it is a bearer
 * secret, and an error message is a log line waiting to happen. The caller logs
 * a feed id and a host hash (`hostHashOf`) and nothing else.
 *
 * ── The test seam ────────────────────────────────────────────────
 *
 * `resolve`, `dialOverride` and `ca` exist so a test can prove all of the above
 * against a real TLS server on loopback. `dialOverride` redirects the socket
 * *after* the DNS answer has been validated, so it cannot be used to skip the
 * guard — and both it and `ca` refuse to exist under NODE_ENV=production, so a
 * deployment cannot be configured into connecting somewhere unvalidated or
 * trusting a certificate the platform does not.
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupAddress } from 'node:dns';
import ipaddr from 'ipaddr.js';

export const SAFE_FETCH_USER_AGENT = 'MaybeSitter-ICS/1.0';
export const DEFAULT_MAX_BYTES = 2_097_152;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_REDIRECTS = 3;

export type SafeFetchErrorCode =
  | 'invalid_url'
  | 'invalid_options'
  | 'blocked_scheme'
  | 'blocked_port'
  | 'blocked_credentials'
  | 'blocked_host'
  | 'blocked_address'
  | 'too_many_redirects'
  | 'too_large'
  | 'timeout'
  | 'bad_content_type'
  | 'http_status'
  | 'network';

/**
 * A refusal, by reason. The message is fixed per code and never carries the
 * URL, the host, an address from DNS or anything the server sent.
 */
export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  /** The HTTP status, for `http_status` only. */
  readonly status: number | null;

  constructor(code: SafeFetchErrorCode, status: number | null = null) {
    super(status === null ? `safe fetch refused: ${code}` : `safe fetch refused: ${code} ${status}`);
    this.name = 'SafeFetchError';
    this.code = code;
    this.status = status;
  }
}

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** From the last successful fetch, sent to the first hop only. */
  etag?: string | null;
  lastModified?: string | null;
  /** Test seam: stands in for DNS. The answer is validated exactly as a real one. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Test seam: where the socket goes *after* the answer passed the guard. Refused in production. */
  dialOverride?: { address: string; port: number };
  /** Test seam: an extra trusted CA. Refused in production. */
  ca?: string;
}

export type SafeFetchResult =
  | { notModified: true; etag: string | null; lastModified: string | null }
  | { notModified: false; body: string; etag: string | null; lastModified: string | null };

/** A host name that can go in a log line: twelve hex characters of its sha-256. */
export function hostHashOf(host: string): string {
  return createHash('sha256').update(host.toLowerCase()).digest('hex').slice(0, 12);
}

/* ── Rule 1: the URL ───────────────────────────────────────────────── */

/**
 * Names that only ever mean something inside a network. `localhost` and
 * `metadata` are single labels and fall to the rule below; the metadata
 * server's full name falls to `.internal`.
 */
const BLOCKED_SUFFIXES = ['.internal', '.local', '.localhost'];

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * The URL a feed is fetched from, or a refusal. Exported so a route can refuse
 * a bad paste with a 400 before storing anything.
 */
export function normalizeFeedUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 2048) throw new SafeFetchError('invalid_url');
  let text = raw.trim();
  if (/^webcal:/i.test(text)) text = `https:${text.slice('webcal:'.length)}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SafeFetchError('invalid_url');
  }
  checkUrl(url);
  return url;
}

function checkUrl(url: URL): void {
  if (url.protocol !== 'https:') throw new SafeFetchError('blocked_scheme');
  if (url.username !== '' || url.password !== '') throw new SafeFetchError('blocked_credentials');
  // `URL` reports the default port as the empty string.
  if (url.port !== '' && url.port !== '443') throw new SafeFetchError('blocked_port');

  // A trailing dot is the same name, fully qualified: `metadata.google.internal.`
  // resolves exactly where the dotless one does, and would otherwise slip past
  // every suffix below.
  const host = stripBrackets(url.hostname).toLowerCase().replace(/\.+$/, '');
  if (host === '') throw new SafeFetchError('invalid_url');
  if (ipaddr.isValid(host)) {
    assertPublicAddress(host);
    return;
  }
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new SafeFetchError('blocked_host');
  }
  // A single label — `intranet`, `metadata` — only ever resolves through a
  // search domain, which is to say to something internal.
  if (!host.includes('.')) throw new SafeFetchError('blocked_host');
}

/* ── Rule 2: addresses ─────────────────────────────────────────────── */

/**
 * Refuses anything that is not global unicast.
 *
 * `ipaddr.process` unwraps `::ffff:10.0.0.5` to `10.0.0.5` first, which is the
 * whole of the IPv4-mapped bypass. What remains is refused unless its range is
 * exactly `unicast`: that excludes private, loopback, link-local (and with it
 * the metadata server), unique-local, carrier-grade NAT, reserved, multicast,
 * broadcast and unspecified — and also NAT64 and 6to4, which can embed a
 * private IPv4 address inside a public-looking IPv6 one.
 */
export function assertPublicAddress(address: string): void {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.process(address);
  } catch {
    throw new SafeFetchError('blocked_address');
  }
  if (parsed.range() !== 'unicast') throw new SafeFetchError('blocked_address');
}

async function defaultResolve(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
      if (error) reject(error);
      else resolve(addresses.map((entry) => entry.address));
    });
  });
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * The socket's `lookup` hook: resolve, validate every address, and hand the
 * socket exactly what was validated.
 *
 * Node 20+ calls this with `all: true` when it races address families, and
 * expects an array back; older paths expect one address. Both are answered.
 */
function validatingLookup(
  resolve: (hostname: string) => Promise<string[]>,
  dialOverride: { address: string } | undefined,
  onBlocked: (error: SafeFetchError) => void,
) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname).then((addresses) => {
      if (addresses.length === 0) {
        callback(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '', 4);
        return;
      }
      try {
        for (const address of addresses) assertPublicAddress(address);
      } catch (error) {
        onBlocked(error as SafeFetchError);
        callback(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }), '', 4);
        return;
      }
      const dialled = dialOverride
        ? [dialOverride.address]
        : addresses;
      const entries = dialled.map((address) => ({ address, family: ipaddr.parse(address).kind() === 'ipv6' ? 6 : 4 }));
      if (options.all) callback(null, entries);
      else callback(null, entries[0]!.address, entries[0]!.family);
    }, (error: NodeJS.ErrnoException) => callback(error, '', 4));
  };
}

/* ── Rules 3–5: one hop ────────────────────────────────────────────── */

type Hop =
  | { kind: 'redirect'; location: string }
  | { kind: 'not_modified'; etag: string | null; lastModified: string | null }
  | { kind: 'body'; body: string; contentType: string | null; etag: string | null; lastModified: string | null };

function header(response: IncomingMessage, name: string): string | null {
  const value = response.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

interface HopContext {
  url: URL;
  conditional: { etag?: string | null; lastModified?: string | null } | null;
  maxBytes: number;
  signal: AbortSignal;
  resolve: (hostname: string) => Promise<string[]>;
  dialOverride?: { address: string; port: number };
  ca?: string;
}

function fetchHop(context: HopContext): Promise<Hop> {
  return new Promise<Hop>((resolvePromise, rejectPromise) => {
    let settled = false;
    let blocked: SafeFetchError | null = null;
    const finish = (outcome: Hop | SafeFetchError): void => {
      if (settled) return;
      settled = true;
      if (outcome instanceof SafeFetchError) rejectPromise(outcome);
      else resolvePromise(outcome);
    };

    const host = stripBrackets(context.url.hostname);
    const isIpLiteral = ipaddr.isValid(host);
    const headers: Record<string, string> = {
      host: context.url.hostname,
      'user-agent': SAFE_FETCH_USER_AGENT,
      accept: 'text/calendar, text/plain;q=0.5, */*;q=0.1',
      'accept-encoding': 'identity',
    };
    if (context.conditional?.etag) headers['if-none-match'] = context.conditional.etag;
    if (context.conditional?.lastModified) headers['if-modified-since'] = context.conditional.lastModified;

    const req = httpsRequest({
      protocol: 'https:',
      // Node skips the lookup hook for an IP literal and connects to it as
      // written, which is safe only because `checkUrl` has already validated
      // that literal — on the first hop and again on every redirect.
      hostname: host,
      port: context.dialOverride?.port ?? 443,
      path: `${context.url.pathname}${context.url.search}`,
      method: 'GET',
      headers,
      agent: false,
      lookup: validatingLookup(
        context.resolve,
        context.dialOverride,
        (error) => { blocked = error; },
      ) as never,
      ...(isIpLiteral ? {} : { servername: host }),
      rejectUnauthorized: true,
      ...(context.ca ? { ca: context.ca } : {}),
      signal: context.signal,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const etag = header(response, 'etag');
      const lastModified = header(response, 'last-modified');

      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = header(response, 'location');
        response.resume();
        if (!location) return finish(new SafeFetchError('http_status', status));
        return finish({ kind: 'redirect', location });
      }
      if (status === 304) {
        response.resume();
        return finish({ kind: 'not_modified', etag, lastModified });
      }
      if (status < 200 || status > 299) {
        response.resume();
        return finish(new SafeFetchError('http_status', status));
      }

      const encoding = (header(response, 'content-encoding') ?? 'identity').trim().toLowerCase();
      if (encoding !== '' && encoding !== 'identity') {
        finish(new SafeFetchError('bad_content_type'));
        return response.destroy();
      }

      const declared = header(response, 'content-length');
      if (declared !== null && Number(declared) > context.maxBytes) {
        finish(new SafeFetchError('too_large'));
        return response.destroy();
      }

      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > context.maxBytes) {
          // Settled before the socket is torn down: destroying it first emits
          // an error that would otherwise be reported as a network failure.
          finish(new SafeFetchError('too_large'));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        finish({
          kind: 'body',
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: header(response, 'content-type'),
          etag,
          lastModified,
        });
      });
      response.on('error', () => finish(context.signal.aborted ? new SafeFetchError('timeout') : new SafeFetchError('network')));
      response.on('aborted', () => finish(context.signal.aborted ? new SafeFetchError('timeout') : new SafeFetchError('network')));
    });

    req.on('error', () => {
      if (blocked) return finish(blocked);
      finish(context.signal.aborted ? new SafeFetchError('timeout') : new SafeFetchError('network'));
    });
    req.end();
  });
}

function mediaTypeOf(contentType: string | null): string | null {
  if (contentType === null) return null;
  return contentType.split(';')[0]!.trim().toLowerCase();
}

/** A body is a calendar if, after a BOM and whitespace, it opens with the line that makes it one. */
function opensAsCalendar(body: string): boolean {
  return /^﻿?\s*BEGIN:VCALENDAR/i.test(body);
}

function checkContentType(contentType: string | null, body: string): void {
  const media = mediaTypeOf(contentType);
  if (media === 'text/calendar') return;
  if ((media === null || media === 'text/plain' || media === 'application/octet-stream') && opensAsCalendar(body)) return;
  throw new SafeFetchError('bad_content_type');
}

/* ── The fetch ─────────────────────────────────────────────────────── */

function checkOptions(options: SafeFetchOptions): void {
  if ((options.dialOverride || options.ca) && process.env.NODE_ENV === 'production') {
    throw new SafeFetchError('invalid_options');
  }
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  checkOptions(options);
  let url = normalizeFeedUrl(rawUrl);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    for (let redirects = 0; ; redirects += 1) {
      const hop = await fetchHop({
        url,
        conditional: redirects === 0 ? { etag: options.etag, lastModified: options.lastModified } : null,
        maxBytes,
        signal: controller.signal,
        resolve: options.resolve ?? defaultResolve,
        ...(options.dialOverride ? { dialOverride: options.dialOverride } : {}),
        ...(options.ca ? { ca: options.ca } : {}),
      });
      if (hop.kind === 'redirect') {
        if (redirects >= maxRedirects) throw new SafeFetchError('too_many_redirects');
        let next: URL;
        try {
          next = new URL(hop.location, url);
        } catch {
          throw new SafeFetchError('invalid_url');
        }
        // Rule 1 again, from scratch; rule 2 runs again in the next hop's lookup.
        url = normalizeFeedUrl(next.href);
        continue;
      }
      if (hop.kind === 'not_modified') {
        return { notModified: true, etag: hop.etag, lastModified: hop.lastModified };
      }
      checkContentType(hop.contentType, hop.body);
      return { notModified: false, body: hop.body, etag: hop.etag, lastModified: hop.lastModified };
    }
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    throw new SafeFetchError(controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}
