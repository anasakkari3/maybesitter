/**
 * The legacy `/api/capture` route authenticates and bounds its input (#511).
 *
 * The route is not the product — the middleware 404s it on Cloud Run — but it
 * is still reachable wherever that guard does not run, and it used to answer
 * anybody, with no token and no length limit, on a path that feeds user text
 * straight into the extractor. An unauthenticated caller could spend the
 * server's LLM budget, and a megabyte of text reached regexes #508 measured as
 * quadratic.
 *
 * The fix is the one the mobile surface already has: `requireMobileUser`
 * before anything else, and the `CaptureInputTooLargeError` boundary #508 put
 * under every capture path — here enforced in `captureText`, the lowest point
 * this route shares, and mapped to the same 413 `text_too_long` the mobile
 * route answers with.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// A dead port, set before the route module (and the extractor beneath it) is
// imported: the positive control below must fall back to the rule-based engine
// in milliseconds, and must never reach a model that happens to be running on
// this machine. Static imports would evaluate before this line, so the route
// is imported lazily by `loadRoute`.
process.env.MAYBESITTER_LLM_BASE_URL = 'http://127.0.0.1:1';

import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { CAPTURE_INPUT_MAX_CHARACTERS } from '../../src/contracts/v1/captureContracts.ts';

type CaptureRoute = typeof import('../../src/app/api/capture/route.ts');
let routePromise: Promise<CaptureRoute> | null = null;
function loadRoute(): Promise<CaptureRoute> {
  routePromise ??= import('../../src/app/api/capture/route.ts');
  return routePromise;
}

async function postCapture(body: unknown, token?: string): Promise<Response> {
  const { POST } = await loadRoute();
  return POST(new Request('http://localhost:3000/api/capture', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }));
}

let auth: FakeAuthControls | null = null;

function begin(): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
}

function end(): void {
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

test('legacy /api/capture refuses a request with no token (#511)', async () => {
  const response = await postCapture({ text: 'Call the doctor at noon' });
  assert.equal(response.status, 401);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.success, false);
  assert.equal(body.reason, 'missing_token');
});

test('legacy /api/capture refuses a forged token (#511)', async () => {
  begin();
  try {
    const response = await postCapture({ text: 'Call the doctor at noon' }, 'p-token.forged');
    assert.equal(response.status, 401);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.reason, 'invalid_token');
  } finally {
    end();
  }
});

test('legacy /api/capture refuses oversized input in the shape the client already reads (#511)', async () => {
  begin();
  try {
    const oversized = `Call the doctor at noon ${'x'.repeat(CAPTURE_INPUT_MAX_CHARACTERS)}`;
    assert.ok(oversized.length > CAPTURE_INPUT_MAX_CHARACTERS);
    const response = await postCapture({ text: oversized }, tokenFor(uidFor('LegacyOversized')));
    assert.equal(response.status, 413, 'the route accepted a capture larger than the server limit');
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.success, false);
    // The same refusal the mobile route answers with (#508): the status, the
    // reason code, and the limit are the vocabulary the client already parses.
    assert.equal(body.reason, 'text_too_long');
    assert.equal(body.maxCharacters, CAPTURE_INPUT_MAX_CHARACTERS);
  } finally {
    end();
  }
});

test('legacy /api/capture still answers an authenticated, in-bounds capture (#511)', async () => {
  begin();
  try {
    const response = await postCapture({ text: 'Call mom' }, tokenFor(uidFor('LegacyInBounds')));
    assert.equal(response.status, 200, 'an authenticated capture below the limit was refused');
    const body = await response.json() as Record<string, unknown>;
    // "Call mom" names no time, so the honest answer is a clarification. What
    // this control pins is that the request cleared both guards — a route that
    // always 401s, or a cap that fires on every input, fails here.
    assert.equal((body.meta as Record<string, unknown>).disposition, 'needs_clarification');
  } finally {
    end();
  }
});
