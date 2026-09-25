/**
 * Every request body is bounded while it is read, not after it is parsed.
 *
 * `request.json()` buffers the whole body before any rule can look at it, and
 * every length rule this product had (#508, #513, the profile-import 413) was
 * a character count on the parsed object — below the allocation, not above
 * it. Production is one Cloud Run service (`http1`, 32 MiB request ceiling,
 * `--memory=1Gi`, `--concurrency=40`), so forty concurrent 30 MiB bodies on
 * any authenticated route put more than 1.2 GB on one instance and take every
 * other user's in-flight request down with it.
 *
 * Three claims, each defended in a way that cannot decay quietly:
 *
 *  A. **The scan.** No route or library file reads a body through the platform
 *     directly. Enumerated from the filesystem, so the route nobody remembered
 *     is covered the day it appears; and a file that uses the bounded reader
 *     must also name `RequestBodyTooLargeError`, because a bare `catch {}`
 *     would swallow the 413 into the route's 400 and the bound would hold
 *     while the answer lied.
 *  B. **The reader.** Exact limit accepted, one byte over refused, a lying or
 *     absent `Content-Length` refused by the byte counter at most one chunk
 *     past the limit (a counting stream proves the pull stopped), and a
 *     malformed body still raises the `SyntaxError` `request.json()` raised.
 *  C. **The routes.** Three real handlers, in process, behind the real auth
 *     seam: an over-sized body answers 413 `payload_too_large` and leaves the
 *     storage adapter untouched. The share route, the one that takes bytes,
 *     is held to its own bound the same way with no `Content-Length` at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import {
  DEFAULT_BODY_LIMIT_BYTES,
  RequestBodyTooLargeError,
  readBoundedBytes,
  readJsonBody,
  requestBodyTooLargeResponse,
} from '../../lib/net/requestBody.ts';
import { MAX_TOTAL_BYTES } from '../../lib/services/share/shareIntakeService.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as memoryPost } from '../../src/app/api/mobile/memory/route.ts';
import { POST as planActionsPost } from '../../src/app/api/mobile/plans/[date]/actions/route.ts';
import { POST as sharePost } from '../../src/app/api/mobile/capture/share/route.ts';

const ROOT = process.cwd();
const HELPER = 'lib/net/requestBody.ts';

/* ───────────────────────────── A. the scan ───────────────────────────── */

/**
 * Files that read a body through the platform on purpose, each with the
 * reason. A new entry here is a decision somebody takes, not a file that
 * appears.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'src/app/api/mobile/capture/share/route.ts':
    'calls `.formData()` on a Response built over bytes `readBoundedBytes` already counted; asserted below',
  // The frozen legacy web surface. `src/middleware.ts` answers 404 for every
  // path outside `/api/mobile/**` and the site on Cloud Run (`K_SERVICE`), so
  // none of these is reachable in production. They are listed rather than
  // pattern-matched so that a route moving into production reach has to come
  // here and say so.
  'src/app/api/action/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/agenda/action/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/analytics/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/capture/route.ts': 'legacy web route, 404 in production by src/middleware.ts (#511 bounds its text)',
  'src/app/api/commitment/[id]/action/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/commitment/[id]/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/commitment/create/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/commitments/clear/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/digest/confirm/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/next-step/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/personalization/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/pilot/incidents/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/pilot/trust/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/pressure/delivery/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/recommendation/review/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
  'src/app/api/release/route.ts': 'legacy web route, 404 in production by src/middleware.ts',
};

function walk(directory: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path, keep));
    else if (keep(entry)) found.push(path);
  }
  return found.sort();
}

/** Comments out, so a doc line that mentions `request.json()` is not a read. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const RAW_READ = /\b(?:request|req)\s*\.\s*(?:json|text|formData|arrayBuffer|blob|bytes)\s*\(/;
const ANY_FORM_DATA = /\.formData\s*\(/;
const BOUNDED_READ = /\bread(?:JsonBody|BoundedText|BoundedBytes)\s*\(/;

const scanned = [
  ...walk(join(ROOT, 'src', 'app', 'api'), (name) => name === 'route.ts'),
  ...walk(join(ROOT, 'lib'), (name) => /\.tsx?$/.test(name)),
].map((path) => relative(ROOT, path));

test('A. the scan covers the files it is about', () => {
  assert.ok(scanned.includes(HELPER), 'the helper itself is in the scanned set');
  assert.ok(scanned.some((file) => file.startsWith('src/app/api/mobile/')), 'mobile routes are scanned');
  assert.ok(scanned.length > 60, `scanned ${scanned.length} files`);
  for (const file of Object.keys(EXEMPT)) {
    assert.ok(scanned.includes(file), `exempt file exists and is scanned: ${file}`);
  }
});

test('A. no route or library file reads a request body through the platform', () => {
  const offenders: string[] = [];
  for (const file of scanned) {
    if (file === HELPER || file in EXEMPT) continue;
    const source = codeOnly(readFileSync(join(ROOT, file), 'utf8'));
    if (RAW_READ.test(source) || ANY_FORM_DATA.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `unbounded body reads:\n${offenders.join('\n')}`);
});

test('A. the share route parses only bytes it has already counted', () => {
  const source = codeOnly(readFileSync(join(ROOT, 'src/app/api/mobile/capture/share/route.ts'), 'utf8'));
  assert.doesNotMatch(source, /\brequest\s*\.\s*formData\s*\(/, 'formData() must not run on the raw request');
  assert.match(source, /readBoundedBytes\s*\(\s*request/, 'the request is read through the bounded reader');
  assert.match(source, /new Response\([^)]*\)\s*\.formData\(\)|\.formData\(\)/, 'the form is parsed from the bounded bytes');
  assert.match(source, /RequestBodyTooLargeError/, 'the byte-bound refusal is mapped, not swallowed');
});

/**
 * Per occurrence, not per file. An import alone, or one mapped read next to a
 * second read inside a bare `catch {}`, would satisfy "the file mentions the
 * error"; what has to hold is that every read has a mapping. The check is
 * the count: `instanceof RequestBodyTooLargeError` at least as many times as
 * the reader is called. (`tsc` has no `noUnusedLocals`, so a dead import is
 * not caught anywhere else.)
 */
const TOO_LARGE_MAPPING = /\binstanceof\s+RequestBodyTooLargeError\b/g;
const BOUNDED_READ_ALL = /\bread(?:JsonBody|BoundedText|BoundedBytes)\s*\(/g;

test('A. every call of the bounded reader has its own 413 mapping', () => {
  const swallowing: string[] = [];
  let reads = 0;
  for (const file of scanned) {
    if (file === HELPER) continue;
    const source = codeOnly(readFileSync(join(ROOT, file), 'utf8'));
    const calls = (source.match(BOUNDED_READ_ALL) ?? []).length;
    if (calls === 0) continue;
    reads += calls;
    const mappings = (source.match(TOO_LARGE_MAPPING) ?? []).length;
    if (mappings < calls) swallowing.push(`${file}: ${calls} bounded read(s), ${mappings} instanceof RequestBodyTooLargeError`);
  }
  assert.ok(reads >= 50, `the mobile surface reads through the helper (${reads} calls found)`);
  assert.deepEqual(swallowing, [], `bounded read whose 413 a bare catch would swallow:\n${swallowing.join('\n')}`);
});

test('A. the exemptions are all still needed', () => {
  const stale: string[] = [];
  for (const file of Object.keys(EXEMPT)) {
    const source = codeOnly(readFileSync(join(ROOT, file), 'utf8'));
    if (!RAW_READ.test(source) && !ANY_FORM_DATA.test(source)) stale.push(file);
  }
  assert.deepEqual(stale, [], `exempt but no longer reading raw:\n${stale.join('\n')}`);
});

/* ──────────────────────────── B. the reader ──────────────────────────── */

const URL_ = 'http://127.0.0.1:4321/api/mobile/anything';

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
}

/** A JSON document of exactly `bytes` bytes. */
function jsonOfSize(bytes: number): string {
  const frame = '{"pad":""}';
  assert.ok(bytes >= frame.length);
  return `{"pad":"${'x'.repeat(bytes - frame.length)}"}`;
}

/**
 * A body that arrives in `chunk`-byte pieces and counts how many were pulled.
 * There is no `Content-Length`: a streamed request body has none, which is
 * the case the header check cannot cover.
 */
function chunkedRequest(
  totalBytes: number,
  chunk: number,
  headers: Record<string, string> = {},
): { request: Request; pulled: () => number; cancelled: () => boolean } {
  let sent = 0;
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      pulls += 1;
      const size = Math.min(chunk, totalBytes - sent);
      controller.enqueue(new Uint8Array(size).fill(0x78));
      sent += size;
    },
    cancel() {
      cancelled = true;
    },
  // No read-ahead: with the default highWaterMark of 1 the stream pulls one
  // chunk at construction, before anybody reads, and the count would lie by one.
  }, { highWaterMark: 0 });
  const request = new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: stream,
    // Required by the fetch spec for a streamed request body.
    ...({ duplex: 'half' } as object),
  });
  return { request, pulled: () => pulls, cancelled: () => cancelled };
}

test('B. the default bound is generous for every legitimate payload and small next to the instance', () => {
  assert.equal(DEFAULT_BODY_LIMIT_BYTES, 256 * 1024);
  // The largest JSON field any mobile route accepts: the profile import at
  // 4,000 characters, at most 4 bytes each in UTF-8.
  assert.ok(DEFAULT_BODY_LIMIT_BYTES > 16 * 4_000, 'over sixteen times the largest legitimate payload');
  // Forty concurrent readers (Cloud Run `--concurrency=40`) at the bound.
  assert.ok(40 * DEFAULT_BODY_LIMIT_BYTES < 64 * 1024 * 1024, 'forty at once stay under 64 MiB');
});

test('B. a body of exactly the limit is accepted', async () => {
  const body = jsonOfSize(DEFAULT_BODY_LIMIT_BYTES);
  const parsed = await readJsonBody<{ pad: string }>(jsonRequest(body));
  assert.equal(parsed.pad.length, DEFAULT_BODY_LIMIT_BYTES - '{"pad":""}'.length);
});

test('B. one byte over the limit is refused with the 413 shape', async () => {
  const body = jsonOfSize(DEFAULT_BODY_LIMIT_BYTES + 1);
  await assert.rejects(readJsonBody(jsonRequest(body)), (error: unknown) => {
    assert.ok(error instanceof RequestBodyTooLargeError);
    assert.equal(error.maxBytes, DEFAULT_BODY_LIMIT_BYTES);
    const response = requestBodyTooLargeResponse(error);
    assert.equal(response.status, 413);
    return true;
  });
  const response = requestBodyTooLargeResponse(new RequestBodyTooLargeError(DEFAULT_BODY_LIMIT_BYTES, false));
  assert.deepEqual(await response.json(), {
    success: false,
    error: `the request body may be at most ${DEFAULT_BODY_LIMIT_BYTES} bytes`,
    reason: 'payload_too_large',
    maxBytes: DEFAULT_BODY_LIMIT_BYTES,
  });
});

test('B. a Content-Length over the limit is refused before a byte is read', async () => {
  // The header lies upward; the body is tiny. Nothing must be pulled. (Built
  // in one step: cloning a streamed Request tees its body, which pulls.)
  const { request: lying, pulled } = chunkedRequest(64, 16, { 'content-length': String(DEFAULT_BODY_LIMIT_BYTES + 1) });
  await assert.rejects(readBoundedBytes(lying), (error: unknown) => {
    assert.ok(error instanceof RequestBodyTooLargeError);
    assert.equal(error.declared, true);
    return true;
  });
  assert.equal(pulled(), 0, 'refused from the header alone');
});

test('B. with no Content-Length, a body twice the limit is cancelled at most one chunk past it', async () => {
  const limit = 64 * 1024;
  const chunk = 4 * 1024;
  const { request, pulled, cancelled } = chunkedRequest(2 * limit, chunk);
  assert.equal(request.headers.get('content-length'), null);
  await assert.rejects(readJsonBody(request, { limitBytes: limit }), (error: unknown) => {
    assert.ok(error instanceof RequestBodyTooLargeError);
    assert.equal(error.declared, false);
    return true;
  });
  const maxPulls = Math.ceil((limit + chunk) / chunk);
  assert.ok(pulled() <= maxPulls, `stopped pulling after ${pulled()} chunks (limit + one chunk is ${maxPulls})`);
  assert.ok(pulled() >= Math.ceil(limit / chunk), 'it did read up to the limit before deciding');
  assert.equal(cancelled(), true, 'the source was cancelled, not abandoned');
});

test('B. a small lying Content-Length over a large body is refused by the counter', async () => {
  const limit = 16 * 1024;
  const { request: lying, pulled } = chunkedRequest(4 * limit, 1024, { 'content-length': '10' });
  await assert.rejects(readBoundedBytes(lying, { limitBytes: limit }), (error: unknown) => {
    assert.ok(error instanceof RequestBodyTooLargeError);
    assert.equal(error.declared, false, 'the header said 10; the bytes said otherwise');
    return true;
  });
  assert.ok(pulled() <= limit / 1024 + 1, `pulled ${pulled()} KiB chunks`);
});

test('B. malformed and empty JSON raise the same SyntaxError request.json() raises', async () => {
  for (const body of ['{not json', '', '   ', '[1,']) {
    const [platform, bounded] = await Promise.allSettled([
      jsonRequest(body).json(),
      readJsonBody(jsonRequest(body)),
    ]);
    assert.equal(platform.status, 'rejected');
    assert.equal(bounded.status, 'rejected');
    assert.ok((platform as PromiseRejectedResult).reason instanceof SyntaxError);
    assert.ok((bounded as PromiseRejectedResult).reason instanceof SyntaxError, `bounded reader raised ${String((bounded as PromiseRejectedResult).reason)}`);
  }
});

test('B. a request with no body reads as empty text and as a JSON SyntaxError', async () => {
  const request = new Request(URL_, { method: 'POST' });
  assert.equal(request.body, null);
  assert.deepEqual(await readBoundedBytes(request), new Uint8Array(0));
  await assert.rejects(readJsonBody(new Request(URL_, { method: 'POST' })), SyntaxError);
});

test('B. UTF-8 is decoded the way request.json() decodes it, BOM included', async () => {
  const text = '﻿{"note":"موعد الطبيب — 12:30 🙂"}';
  assert.deepEqual(await readJsonBody(jsonRequest(text)), await jsonRequest(text).json());
});

/* ──────────────────────────── C. the routes ──────────────────────────── */

const USER = uidFor('BodyBoundUser');
const BASE = 'http://127.0.0.1:4321';

let auth: FakeAuthControls | null = null;
let storage: ReturnType<typeof createMemoryStorage> | null = null;
const savedEnv: Record<string, string | undefined> = {};

function begin(env: Record<string, string>): void {
  auth = installFakeAuth();
  storage = createMemoryStorage();
  setStorageForTests(storage);
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
}

function end(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  resetStorageForTests();
  auth?.restore();
  auth = null;
  storage = null;
}

/** An authenticated JSON POST whose body streams in without a Content-Length. */
function oversizedPost(path: string, totalBytes = DEFAULT_BODY_LIMIT_BYTES * 2): { request: Request; pulled: () => number } {
  const { request, pulled } = chunkedRequest(totalBytes, 8 * 1024);
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${tokenFor(USER)}`);
  return { request: new Request(`${BASE}${path}`, { method: 'POST', headers, body: request.body, ...({ duplex: 'half' } as object) }), pulled };
}

async function expectRefusedUntouched(
  run: (request: Request) => Promise<Response>,
  path: string,
  reason = 'payload_too_large',
): Promise<void> {
  // Warm the auth seam first: `requireMobileUser` creates the user's root
  // document on first sight, and that write is auth's, not the body read's.
  // A malformed body is refused by the route's own 400 after auth has run.
  const warm = await run(new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(USER)}`, 'content-type': 'application/json' },
    body: '{not json',
  }));
  assert.equal(warm.status, 400, `${path} warm-up answered ${warm.status}`);
  const before = storage!.pathsForTests().slice().sort();
  const { request, pulled } = oversizedPost(path);
  const response = await run(request);
  assert.equal(response.status, 413, `${path} answered ${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.success, false);
  assert.equal(body.reason, reason);
  assert.deepEqual(storage!.pathsForTests().slice().sort(), before, `${path} wrote to storage on a refused body`);
  assert.ok(pulled() <= Math.ceil(DEFAULT_BODY_LIMIT_BYTES / (8 * 1024)) + 1, `${path} kept pulling: ${pulled()} chunks`);
}

test('C. POST /api/mobile/capture refuses an over-sized body with 413 and writes nothing', async () => {
  begin({});
  try {
    await expectRefusedUntouched(capturePost, '/api/mobile/capture');
  } finally {
    end();
  }
});

test('C. POST /api/mobile/memory refuses an over-sized body with 413 and writes nothing', async () => {
  begin({ MAYBESITTER_FEATURE_MEMORY: 'true' });
  try {
    await expectRefusedUntouched(memoryPost, '/api/mobile/memory');
  } finally {
    end();
  }
});

test('C. POST /api/mobile/plans/{date}/actions refuses an over-sized body with 413 and writes nothing', async () => {
  begin({});
  try {
    await expectRefusedUntouched(
      (request) => planActionsPost(request, { params: Promise.resolve({ date: '2026-09-25' }) }),
      '/api/mobile/plans/2026-09-25/actions',
    );
  } finally {
    end();
  }
});

test('C. a well-formed body under the bound still reaches the route (positive control)', async () => {
  begin({});
  try {
    const request = new Request(`${BASE}/api/mobile/plans/2026-09-25/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(USER)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'explode' }),
    });
    const response = await planActionsPost(request, { params: Promise.resolve({ date: '2026-09-25' }) });
    assert.equal(response.status, 400, 'the route ran and refused the action, not the body');
    assert.match(String((await response.json() as { error: string }).error), /Unknown plan action/);
  } finally {
    end();
  }
});

test('C. an unauthenticated over-sized body is refused by auth before a byte is read', async () => {
  begin({});
  try {
    const { request, pulled } = chunkedRequest(DEFAULT_BODY_LIMIT_BYTES * 2, 8 * 1024);
    const anonymous = new Request(`${BASE}/api/mobile/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: request.body,
      ...({ duplex: 'half' } as object),
    });
    const response = await capturePost(anonymous);
    assert.equal(response.status, 401);
    assert.equal(pulled(), 0, 'auth ran first; nothing was pulled');
  } finally {
    end();
  }
});

test('C. POST /api/mobile/capture/share with no Content-Length is cut off at its byte bound', async () => {
  begin({ SHARE_INTAKE_ENABLED: 'true' });
  try {
    const chunk = 256 * 1024;
    const total = MAX_TOTAL_BYTES + 4 * 1024 * 1024;
    const { request, pulled, cancelled } = chunkedRequest(total, chunk);
    const share = new Request(`${BASE}/api/mobile/capture/share`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenFor(USER)}`,
        'content-type': 'multipart/form-data; boundary=----bound',
      },
      body: request.body,
      ...({ duplex: 'half' } as object),
    });
    assert.equal(share.headers.get('content-length'), null);
    const response = await sharePost(share);
    assert.equal(response.status, 413);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.reason, 'file_too_large');
    assert.equal(body.maxBytes, MAX_TOTAL_BYTES);
    // MAX_TOTAL_BYTES plus the 1 MiB multipart allowance, plus one chunk.
    const maxPulls = Math.ceil((MAX_TOTAL_BYTES + 1024 * 1024 + chunk) / chunk);
    assert.ok(pulled() <= maxPulls, `share kept pulling: ${pulled()} chunks (bound ${maxPulls})`);
    assert.equal(cancelled(), true);
  } finally {
    end();
  }
});

test('C. a multipart share under the bound still parses through the bounded path (positive control)', async () => {
  begin({ SHARE_INTAKE_ENABLED: 'true' });
  try {
    const form = new FormData();
    form.set('text', 'اتصل بالطبيب بكرة الساعة 10');
    form.set('timezone', 'Asia/Jerusalem');
    form.set('referenceTime', '2026-09-25T08:00:00.000Z');
    const response = await sharePost(new Request(`${BASE}/api/mobile/capture/share`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(USER)}` },
      body: form,
    }));
    // Whatever the service decides about the text, the form was read: a body
    // this route could not parse answers 400 "not a readable multipart form".
    assert.notEqual(response.status, 400, `share answered ${response.status}: ${await response.text()}`);
    assert.notEqual(response.status, 413);
  } finally {
    end();
  }
});

/* ─────────────────────── B'. the chunk-object hole ─────────────────────── */

/**
 * A body sent as one-byte chunks is the cheap way to make a byte counter
 * expensive: 262,145 chunks is 262,145 `Uint8Array` views. A reader that
 * keeps them in an array until the count passes the limit measured +164 MiB
 * RSS and ~450 ms per request through a real HTTP server — forty of those on
 * a 1Gi instance is the outage this module exists to prevent. The reader
 * copies each chunk into one growing buffer instead, so the views are
 * garbage the moment they are read.
 *
 * The assertion is on `process.memoryUsage()`: `arrayBuffers` is exact
 * (every view's backing store counts until it is collected, and they are
 * collected only if nothing holds them), `heapUsed` is a ceiling loose
 * enough for a scavenge to be pending. The mutation this was written
 * against — `chunks.push(part.value)` — measured +71 MiB heap here.
 */
const MiB = 1024 * 1024;

/**
 * A full collection on demand, without a runner flag. The measurement is
 * taken at the *peak* of the read — inside the stream, as the limit+1-th byte
 * is delivered — after a collection, so what is counted is what the reader
 * is holding alive at that moment: one buffer here, 262,145 views for the
 * shape this guards against. A before/after delta would instead measure
 * whatever garbage the runner has not collected yet, which is why the
 * bounds are on live memory at the peak and not on raw growth.
 */
async function forceGc(): Promise<void> {
  const [{ default: v8 }, { default: vm }] = await Promise.all([import('node:v8'), import('node:vm')]);
  v8.setFlagsFromString('--expose-gc');
  (vm.runInNewContext('gc') as () => void)();
}

interface PeakSample { heapUsed: number; arrayBuffers: number }

function liveDelta(before: NodeJS.MemoryUsage, peak: PeakSample | null): { heapMiB: number; arrayBuffersMiB: number } {
  assert.ok(peak, 'the peak was sampled');
  return { heapMiB: (peak!.heapUsed - before.heapUsed) / MiB, arrayBuffersMiB: (peak!.arrayBuffers - before.arrayBuffers) / MiB };
}

/**
 * `totalBytes` one-byte chunks, each a fresh view as a socket delivers them,
 * with no read-ahead. `onLast` runs as the final chunk is about to be
 * delivered, i.e. at the reader's peak.
 */
function oneByteChunks(totalBytes: number, onLast: () => Promise<void> = async () => undefined): { request: Request; pulled: () => number } {
  let sent = 0;
  let pulls = 0;
  const one = new Uint8Array([0x78]);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      pulls += 1;
      sent += 1;
      if (sent === totalBytes) await onLast();
      controller.enqueue(one.slice());
    },
  }, { highWaterMark: 0 });
  const request = new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    ...({ duplex: 'half' } as object),
  });
  return { request, pulled: () => pulls };
}

test("B'. a limit+1 body sent as one-byte chunks holds one buffer at its peak, not one object per chunk", async (t) => {
  const limit = DEFAULT_BODY_LIMIT_BYTES;
  let peak: PeakSample | null = null;
  const { request, pulled } = oneByteChunks(limit + 1, async () => {
    await forceGc();
    peak = process.memoryUsage();
  });
  await forceGc();
  const before = process.memoryUsage();
  await assert.rejects(readBoundedBytes(request, { limitBytes: limit }), RequestBodyTooLargeError);
  assert.equal(pulled(), limit + 1, 'it read exactly limit + 1 one-byte chunks before refusing');
  const { heapMiB, arrayBuffersMiB } = liveDelta(before, peak);
  t.diagnostic(`one-byte chunks, limit+1: live at peak heap +${heapMiB.toFixed(1)} MiB, arrayBuffers +${arrayBuffersMiB.toFixed(1)} MiB`);
  // Measured live at the peak: +2.6 MiB heap / +0.3 MiB arrayBuffers; the
  // retaining shape (`chunks.push(part.value)`) measured +61.6 MiB heap.
  assert.ok(heapMiB < 16, `${heapMiB.toFixed(1)} MiB live on the heap at the peak (bound 16)`);
  assert.ok(arrayBuffersMiB < 4, `${arrayBuffersMiB.toFixed(1)} MiB live in arrayBuffers at the peak (bound 4)`);
});

test("B'. ten such bodies at once hold a few MiB at the peak (the retaining shape measured +682 MiB)", async (t) => {
  const limit = DEFAULT_BODY_LIMIT_BYTES;
  let peak: PeakSample | null = null;
  // Sampled as the first stream reaches its last byte; the other nine are
  // within a few pulls of theirs, the microtask queue being round-robin.
  const requests = Array.from({ length: 10 }, () => oneByteChunks(limit + 1, async () => {
    if (peak) return;
    await forceGc();
    peak = process.memoryUsage();
  }).request);
  await forceGc();
  const before = process.memoryUsage();
  const outcomes = await Promise.allSettled(requests.map((request) => readBoundedBytes(request, { limitBytes: limit })));
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected');
    assert.ok((outcome as PromiseRejectedResult).reason instanceof RequestBodyTooLargeError);
  }
  const { heapMiB, arrayBuffersMiB } = liveDelta(before, peak);
  t.diagnostic(`ten concurrent one-byte-chunk bodies: live at peak heap +${heapMiB.toFixed(1)} MiB, arrayBuffers +${arrayBuffersMiB.toFixed(1)} MiB`);
  assert.ok(heapMiB < 48, `${heapMiB.toFixed(1)} MiB live on the heap at the peak of ten concurrent reads (bound 48)`);
  assert.ok(arrayBuffersMiB < 16, `${arrayBuffersMiB.toFixed(1)} MiB live in arrayBuffers (ten buffers at most; bound 16)`);
});

test("B'. the same body through node:http as raw 1-byte chunked frames", async (t) => {
  const { createServer } = await import('node:http');
  const { connect } = await import('node:net');
  const { Readable } = await import('node:stream');
  const limit = DEFAULT_BODY_LIMIT_BYTES;

  let before: NodeJS.MemoryUsage | null = null;
  let peak: PeakSample | null = null;
  let delivered = 0;
  let bodyChunks = 0;
  const server = createServer(async (req, res) => {
    await forceGc();
    before = process.memoryUsage();
    // The socket's bytes, sampled as the limit+1-th arrives: the reader's peak.
    const sampled = (Readable.toWeb(req) as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        bodyChunks += 1;
        delivered += chunk.byteLength;
        if (peak === null && delivered >= limit + 1) {
          await forceGc();
          peak = process.memoryUsage();
        }
        controller.enqueue(chunk);
      },
    }));
    const request = new Request(`http://127.0.0.1${req.url ?? '/'}`, {
      method: 'POST',
      headers: req.headers as Record<string, string>,
      body: sampled,
      ...({ duplex: 'half' } as object),
    });
    let status = 200;
    try {
      await readJsonBody(request, { limitBytes: limit });
    } catch (error) {
      status = error instanceof RequestBodyTooLargeError ? 413 : 400;
    }
    res.writeHead(status, { connection: 'close' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let response = '';
      socket.on('error', reject);
      socket.on('data', (data) => { response += data.toString('latin1'); });
      socket.on('close', () => {
        const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
        if (match) resolve(Number(match[1]));
        else reject(new Error(`no status line in: ${response.slice(0, 80)}`));
      });
      socket.on('connect', () => {
        socket.write('POST /api/mobile/anything HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n');
        // limit + 1 one-byte frames, batched on the wire but each its own
        // HTTP chunk, which is how the parser delivers them.
        const frame = '1\r\nx\r\n';
        const batch = frame.repeat(4096);
        let remaining = limit + 1;
        const pump = (): void => {
          while (remaining > 0) {
            const n = Math.min(4096, remaining);
            remaining -= n;
            const ok = socket.write(n === 4096 ? batch : frame.repeat(n));
            if (!ok) {
              socket.once('drain', pump);
              return;
            }
          }
          socket.write('0\r\n\r\n');
        };
        pump();
      });
    });
    assert.equal(status, 413);
    assert.ok(bodyChunks > 1000, `the parser delivered the body in ${bodyChunks} pieces, not one`);
    const { heapMiB, arrayBuffersMiB } = liveDelta(before!, peak);
    t.diagnostic(`node:http, ${bodyChunks} body pieces: live at peak heap +${heapMiB.toFixed(1)} MiB, arrayBuffers +${arrayBuffersMiB.toFixed(1)} MiB`);
    assert.ok(heapMiB < 16, `${heapMiB.toFixed(1)} MiB live on the heap at the peak in the handler (bound 16)`);
    assert.ok(arrayBuffersMiB < 4, `${arrayBuffersMiB.toFixed(1)} MiB live in arrayBuffers at the peak (bound 4)`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("B'. the reader keeps no per-chunk array", () => {
  const source = codeOnly(readFileSync(join(ROOT, HELPER), 'utf8'));
  const body = source.slice(source.indexOf('function readBoundedBytes'), source.indexOf('function readBoundedText'));
  assert.doesNotMatch(body, /Uint8Array\[\]|\.push\(/, 'chunks are copied into one buffer, never collected');
  assert.match(body, /buffer\.set\(chunk, length\)/);
});

/* ─────────────────────── D. a JSON body that is not an object ─────────────────────── */

/**
 * `null`, `7` and `[]` are JSON, so the reader hands them over and the route
 * reads `.sessionId` / `.action` / `.enabled` off them — a 500, on main as
 * on this branch. The answer is the route's own 400 for a body it cannot
 * read, the one `readiness` already gives.
 */
async function nullBodyIs400(
  run: (request: Request) => Promise<Response>,
  method: string,
  path: string,
): Promise<void> {
  for (const literal of ['null', '7', '[]', '"text"']) {
    const response = await run(new Request(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${tokenFor(USER)}`, 'content-type': 'application/json' },
      body: literal,
    }));
    assert.equal(response.status, 400, `${method} ${path} with body ${literal} answered ${response.status}`);
    assert.deepEqual(await response.json(), { success: false, error: 'Invalid JSON request body' });
  }
}

test('D. POST /api/mobile/capture answers 400, not 500, to a JSON null body', async () => {
  begin({});
  try {
    await nullBodyIs400(capturePost, 'POST', '/api/mobile/capture');
  } finally {
    end();
  }
});

test('D. POST /api/mobile/commitments/{id}/actions answers 400, not 500, to a JSON null body', async () => {
  const { POST: commitmentActionPost } = await import('../../src/app/api/mobile/commitments/[id]/actions/route.ts');
  begin({});
  try {
    await nullBodyIs400(
      (request) => commitmentActionPost(request, { params: Promise.resolve({ id: 'c-1' }) }),
      'POST',
      '/api/mobile/commitments/c-1/actions',
    );
  } finally {
    end();
  }
});

test('D. PUT /api/mobile/settings/plan answers 400, not 500, to a JSON null body', async () => {
  const { PUT: planSettingsPut } = await import('../../src/app/api/mobile/settings/plan/route.ts');
  begin({});
  try {
    await nullBodyIs400(planSettingsPut, 'PUT', '/api/mobile/settings/plan');
  } finally {
    end();
  }
});
