/**
 * The stranded launch page, still live on Hosting, keeps working when main
 * reaches production.
 *
 * That page (tag `archive/2026-09/stranded/local-main-launch-site`, ba7f74f0,
 * `site/launch.js` + `site/index.html`) posts
 * `Object.fromEntries(new FormData(form))` plus `source` — every value a
 * string — to `/api/early-access`, and `{event, source}` to
 * `/api/early-access/events`. Before this, main answered the first with 422
 * and the second with 404.
 *
 * The high-risk lines each have a test that fails when they are removed:
 * - a legacy body is mapped, and stores no name, no phone and no consent;
 * - a body carrying any current-only field is never read as legacy;
 * - the origin check guards both routes;
 * - `/events` reads no body and writes nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryStorage, type StorageAdapter } from '../../lib/storage/index.ts';
import { EARLY_ACCESS_REGISTRATIONS } from '../../lib/storage/paths.ts';
import {
  RATE_LIMIT_PATH,
  createEarlyAccessStore,
  handleEarlyAccess,
  handleEarlyAccessEvent,
  isLegacyShape,
  EARLY_ACCESS_ERRORS,
  type EarlyAccessErrorCode,
  type EarlyAccessOptions,
  type EarlyAccessRegistration,
  type EarlyAccessStore,
} from '../../lib/earlyAccess/service.ts';
import { isProductionPath } from '../../src/middleware.ts';

const repoRoot = process.cwd();
const ORIGIN = 'https://maybesitter.com';
const CLOUD_RUN_ENV = {
  MAYBESITTER_SITE_ORIGINS: 'https://maybesitter.com,https://maybesitter-app.web.app',
  K_SERVICE: 'maybesitter-api',
} as unknown as NodeJS.ProcessEnv;
const NOW = Date.parse('2026-10-05T09:00:00.000Z');

/** What ba7f74f0's `site/launch.js` sends: the form's five inputs, as strings, plus `source`. */
function legacyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Rana',
    email: '  Legacy@Example.COM ',
    device: 'iphone',
    phone: '+972 50-123-4567',
    website: '',
    source: 'ig-bio',
    ...overrides,
  };
}

/** The current site's body (`site/landing.js`), for the cases that must not be read as legacy. */
function currentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: 'current@example.com',
    device: 'android',
    language: 'ar',
    knowsFounder: 'no',
    whatsappOptIn: false,
    phone: null,
    pageLanguage: 'ar',
    source: 'direct',
    v: 'a',
    website: '',
    ...overrides,
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.internal.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function harness(options: EarlyAccessOptions = {}) {
  const storage = createMemoryStorage();
  const store = createEarlyAccessStore(storage);
  return {
    storage,
    run: (request: Request, extra: EarlyAccessOptions = {}) =>
      handleEarlyAccess(request, { storeFactory: () => store, now: () => NOW, env: CLOUD_RUN_ENV, ...options, ...extra }),
  };
}

async function stored(storage: StorageAdapter): Promise<EarlyAccessRegistration[]> {
  return (await storage.list<EarlyAccessRegistration>(EARLY_ACCESS_REGISTRATIONS)).map((doc) => doc.data);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

// ── POST /api/early-access, legacy shape ─────────────────────────────────

test('the legacy page\'s body is accepted with the answer that page reads as success', async () => {
  const { run } = harness();
  const response = await run(post('/api/early-access', legacyBody()));
  assert.equal(response.status, 200);
  // ba7f74f0's launch.js: `if (!result.ok || data.ok !== true) … throw`.
  assert.deepEqual(await json(response), { ok: true });
});

test('a legacy sign-up is stored as the current record, with no name, no phone and no consent it never gave', async () => {
  const { storage, run } = harness();
  await run(post('/api/early-access', legacyBody()));
  const [record, ...rest] = await stored(storage);
  assert.equal(rest.length, 0);
  assert.deepEqual(record, {
    email: 'legacy@example.com',
    device: 'iphone',
    language: 'en',
    pageLanguage: 'en',
    knowsFounder: null,
    whatsappOptIn: false,
    phone: null,
    source: 'ig-bio',
    v: 'legacy',
    registeredAt: '2026-10-05T09:00:00.000Z',
  });
  const text = JSON.stringify(record);
  assert.ok(!text.includes('Rana'), 'the privacy policy says no name is collected');
  assert.ok(!text.includes('123-4567'), 'a phone number without the WhatsApp opt-in must not be stored');
});

test('a legacy body with the optional phone left blank is accepted the same way', async () => {
  const { storage, run } = harness();
  assert.equal((await run(post('/api/early-access', legacyBody({ phone: '' })))).status, 200);
  assert.equal((await stored(storage))[0]!.phone, null);
});

test('a legacy honeypot hit answers exactly as a current one: 200, and nothing written, not even the rate window', async () => {
  const { storage, run } = harness();
  const legacy = await run(post('/api/early-access', legacyBody({ website: 'https://spam.example' })));
  const current = await run(post('/api/early-access', currentBody({ website: 'https://spam.example' })));
  assert.equal(legacy.status, 200);
  assert.equal(legacy.status, current.status);
  assert.equal(await legacy.text(), await current.text());
  assert.deepEqual(await stored(storage), []);
  assert.equal(await storage.get(RATE_LIMIT_PATH), null);
});

test('a legacy body from an unlisted or cross-site origin is refused and nothing is stored', async () => {
  const refused: Array<Record<string, string>> = [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }];
  for (const headers of refused) {
    const { storage, run } = harness();
    const response = await run(post('/api/early-access', legacyBody(), headers));
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.deepEqual(await stored(storage), []);
  }
});

test('an invalid legacy email or device is a 422 in the shape that page renders, and nothing is stored', async () => {
  const { storage, run } = harness();
  const response = await run(post('/api/early-access', legacyBody({ email: 'nope', device: 'nokia' })));
  assert.equal(response.status, 422);
  // launch.js: `showErrors(data.fields)` indexes by field name, then shows `data.error`.
  assert.deepEqual(await json(response), {
    error: 'Please check the highlighted fields.',
    code: 'invalid_fields',
    fields: { email: 'Please enter a valid email address.', device: 'Please choose iPhone or Android.' },
  });
  assert.deepEqual(await stored(storage), []);
});

test('every error answer carries a sentence in `error` and the machine code in `code`, before or after the body is read', async () => {
  // The legacy page prints `data.error` verbatim, including for the answers
  // given before any body is read, when nobody can tell which page sent it.
  const failing: EarlyAccessStore = { allow: async () => true, register: async () => { throw new Error('UNAVAILABLE'); } };
  const onlyBody = (body: string) => post('/api/early-access', body);
  const cases: Array<[string, () => Promise<Response>, number, EarlyAccessErrorCode]> = [
    ['GET', () => harness().run(new Request('https://api.internal.example/api/early-access', { headers: { origin: ORIGIN } })), 405, 'method_not_allowed'],
    ['unlisted origin', () => harness().run(post('/api/early-access', legacyBody(), { origin: 'https://evil.example' })), 403, 'forbidden_origin'],
    ['form encoding', () => harness().run(post('/api/early-access', 'a=b', { 'content-type': 'application/x-www-form-urlencoded' })), 415, 'unsupported_media_type'],
    ['declared too large', () => harness().run(post('/api/early-access', legacyBody(), { 'content-length': '5000' })), 413, 'payload_too_large'],
    ['not JSON', () => harness().run(onlyBody('{nope')), 400, 'invalid_json'],
    ['legacy invalid', () => harness().run(post('/api/early-access', legacyBody({ email: 'x' }))), 422, 'invalid_fields'],
    ['current invalid', () => harness().run(post('/api/early-access', currentBody({ email: 'x' }))), 422, 'invalid_fields'],
    ['legacy rate limited', () => harness({ hourlyLimit: 0 }).run(post('/api/early-access', legacyBody())), 429, 'rate_limited'],
    ['current rate limited', () => harness({ hourlyLimit: 0 }).run(post('/api/early-access', currentBody())), 429, 'rate_limited'],
    ['store down', () => handleEarlyAccess(post('/api/early-access', legacyBody()), { storeFactory: () => failing, env: CLOUD_RUN_ENV }), 503, 'unavailable'],
    ['/events GET', () => handleEarlyAccessEvent(new Request('https://api.internal.example/api/early-access/events', { headers: { origin: ORIGIN } }), { env: CLOUD_RUN_ENV }), 405, 'method_not_allowed'],
    ['/events unlisted origin', () => handleEarlyAccessEvent(post('/api/early-access/events', '{}', { origin: 'https://evil.example' }), { env: CLOUD_RUN_ENV }), 403, 'forbidden_origin'],
  ];
  for (const [label, run, status, code] of cases) {
    const response = await run();
    assert.equal(response.status, status, label);
    const body = await json(response);
    assert.equal(body.code, code, label);
    assert.equal(body.error, EARLY_ACCESS_ERRORS[code], label);
    // A sentence a person can read, never the code itself.
    assert.match(String(body.error), /^[A-Z][^_]*\.$/, `${label}: ${String(body.error)}`);
  }
});

test('the stranded endpoint\'s own words reach the legacy page', () => {
  assert.equal(EARLY_ACCESS_ERRORS.forbidden_origin, 'Please register from the MaybeSitter website.');
  assert.equal(EARLY_ACCESS_ERRORS.rate_limited, 'Registration is busy right now. Please try again in a little while.');
  assert.equal(EARLY_ACCESS_ERRORS.unavailable, 'We couldn’t save your place just now. Your details are still here—please try again.');
});

test('a body with any current-only field is never read as legacy, so consent cannot be smuggled through it', async () => {
  for (const field of ['v', 'language', 'pageLanguage', 'knowsFounder', 'whatsappOptIn'] as const) {
    assert.equal(isLegacyShape({ ...legacyBody(), [field]: currentBody()[field] }), false, field);
  }
  assert.equal(isLegacyShape(legacyBody()), true);

  // The dangerous one: an opt-in plus a phone, with no `v`. Held to the current contract, it is a 422.
  const { storage, run } = harness();
  const smuggled = await run(post('/api/early-access', legacyBody({ whatsappOptIn: true })));
  assert.equal(smuggled.status, 422);
  assert.ok(((await json(smuggled)).fields as string[]).includes('v'));
  assert.deepEqual(await stored(storage), []);

  // And a current-site body that loses `v` fails loudly rather than landing as a legacy row.
  const { v: _dropped, ...noArm } = currentBody();
  const lost = await run(post('/api/early-access', noArm));
  assert.equal(lost.status, 422);
  assert.deepEqual(await stored(storage), []);
});

test('the current site still gets the field names as a list, and reads only the status', async () => {
  const { run } = harness();
  const response = await run(post('/api/early-access', currentBody({ device: 'nokia' })));
  assert.equal(response.status, 422);
  assert.deepEqual(await json(response), { error: 'Please check the highlighted fields.', code: 'invalid_fields', fields: ['device'] });
  // site/landing.js branches on `response.ok` and `response.status === 422` only, so `error`
  // becoming a sentence changes nothing it shows.
  const landing = readFileSync(join(repoRoot, 'site', 'landing.js'), 'utf8');
  assert.match(landing, /response\.status === 422 \? 'invalid' : 'error'/);
  assert.doesNotMatch(landing, /\.json\(\)|\.error\b|\.code\b/);
});

test('a legacy and a current sign-up for the same email: first one wins, same answer', async () => {
  const { storage, run } = harness();
  const first = await run(post('/api/early-access', legacyBody({ email: 'same@example.com' })));
  const again = await run(post('/api/early-access', currentBody({ email: 'same@example.com' })));
  assert.equal(await first.text(), await again.text());
  const records = await stored(storage);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.v, 'legacy');
});

// ── POST /api/early-access/events ────────────────────────────────────────

/** A request whose body records whether anybody read it. */
function eventRequest(headers: Record<string, string> = {}) {
  let read = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      read = true;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ event: 'page_view', source: 'ig-bio' })));
      controller.close();
    },
  }, { highWaterMark: 0 }); // no pull until somebody reads
  const request = new Request('https://api.internal.example/api/early-access/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers },
    body,
    duplex: 'half',
  } as RequestInit);
  return { request, wasRead: () => read };
}

test('/events answers the legacy ping with 204 and never reads what was sent', async () => {
  const { request, wasRead } = eventRequest();
  const response = await handleEarlyAccessEvent(request, { env: CLOUD_RUN_ENV });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(wasRead(), false, 'a content-free route must not read the body');
});

test('/events keeps the sign-up\'s origin check', async () => {
  const cases: Array<[string, Record<string, string>, NodeJS.ProcessEnv]> = [
    ['unlisted origin', { origin: 'https://evil.example' }, CLOUD_RUN_ENV],
    ['cross-site fetch metadata', { 'sec-fetch-site': 'cross-site' }, CLOUD_RUN_ENV],
    ['no allow-list on Cloud Run', {}, { K_SERVICE: 'maybesitter-api' } as unknown as NodeJS.ProcessEnv],
  ];
  for (const [label, headers, env] of cases) {
    const { request } = eventRequest(headers);
    assert.equal((await handleEarlyAccessEvent(request, { env })).status, 403, label);
  }
  const noOrigin = new Request('https://api.internal.example/api/early-access/events', { method: 'POST', body: '{}' });
  assert.equal((await handleEarlyAccessEvent(noOrigin, { env: CLOUD_RUN_ENV })).status, 403);
});

test('/events is POST-only, touches no store, and production serves exactly that path', async () => {
  const get = await handleEarlyAccessEvent(new Request('https://api.internal.example/api/early-access/events', { headers: { origin: ORIGIN } }), { env: CLOUD_RUN_ENV });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');

  const route = readFileSync(join(repoRoot, 'src', 'app', 'api', 'early-access', 'events', 'route.ts'), 'utf8');
  const verbs = Array.from(route.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g), (m) => m[1]);
  assert.deepEqual(verbs, ['POST']);
  assert.match(route, /handleEarlyAccessEvent\(request\)/);

  // The handler has no store to reach: its only option is the environment.
  const service = readFileSync(join(repoRoot, 'lib', 'earlyAccess', 'service.ts'), 'utf8');
  const handler = service.slice(service.indexOf('export async function handleEarlyAccessEvent'));
  assert.doesNotMatch(handler, /storeFactory|getStorage|\.json\(|\.text\(|\.body\b|readJsonBody/);

  assert.equal(isProductionPath('/api/early-access/events'), true);
  assert.equal(isProductionPath('/api/early-access/events/extra'), false);
  assert.equal(isProductionPath('/api/early-access'), true);
});
