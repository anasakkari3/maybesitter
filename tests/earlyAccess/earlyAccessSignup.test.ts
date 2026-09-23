/**
 * `POST /api/early-access`, held to `site/SIGNUP_CONTRACT.md`.
 *
 * The high-risk boundaries each have a test that fails when the guard is
 * removed:
 * - a phone number without the WhatsApp opt-in is never stored;
 * - a cross-site or unconfigured origin is refused;
 * - a honeypot hit writes nothing;
 * - the exact body the landing page sends is accepted, so reintroducing a
 *   required `name` breaks the site and this test says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryStorage, type StorageAdapter } from '../../lib/storage/index.ts';
import { EARLY_ACCESS_REGISTRATIONS } from '../../lib/storage/paths.ts';
import {
  EARLY_ACCESS_BODY_LIMIT_BYTES,
  RATE_LIMIT_PATH,
  createEarlyAccessStore,
  handleEarlyAccess,
  registrationPath,
  type EarlyAccessOptions,
  type EarlyAccessRegistration,
  type EarlyAccessStore,
} from '../../lib/earlyAccess/service.ts';
import { isProductionPath } from '../../src/middleware.ts';

const repoRoot = process.cwd();
const ORIGIN = 'https://site.example';
const CLOUD_RUN_ENV = { MAYBESITTER_SITE_ORIGINS: ORIGIN, K_SERVICE: 'maybesitter-api' } as unknown as NodeJS.ProcessEnv;
const NOW = Date.parse('2026-10-05T09:00:00.000Z');

/** The body `site/landing.js` builds, field for field. */
function landingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: '  Tester@Example.COM ',
    device: 'android',
    language: 'ar',
    knowsFounder: 'no',
    whatsappOptIn: false,
    phone: null,
    pageLanguage: 'ar',
    source: 'ig-story-1006',
    v: 'a',
    website: '',
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://api.internal.example/api/early-access', {
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

test('a valid sign-up stores exactly the contract fields, normalised, and nothing from the transport', async () => {
  const { storage, run } = harness();
  const response = await run(post(landingBody(), { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'UA-probe/1.0', cookie: 'c=1' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true });

  const [record, ...rest] = await stored(storage);
  assert.equal(rest.length, 0);
  assert.deepEqual(record, {
    email: 'tester@example.com',
    device: 'android',
    language: 'ar',
    pageLanguage: 'ar',
    knowsFounder: 'no',
    whatsappOptIn: false,
    phone: null,
    source: 'ig-story-1006',
    v: 'a',
    registeredAt: '2026-10-05T09:00:00.000Z',
  });
  const text = JSON.stringify(record);
  for (const leaked of ['203.0.113.9', 'UA-probe', 'c=1']) assert.ok(!text.includes(leaked), `${leaked} must never be stored`);
  // The document id is a hash, so the email never appears in a path or a log line.
  assert.ok(await storage.get(registrationPath('tester@example.com')));
  assert.match(registrationPath('tester@example.com'), /^earlyAccessRegistrations\/[0-9a-f]{64}$/);
});

test('the rate-limit window holds a count and a reset time, and nothing about a person', async () => {
  const { storage, run } = harness();
  await run(post(landingBody()));
  const window = await storage.get<Record<string, unknown>>(RATE_LIMIT_PATH);
  assert.deepEqual(Object.keys(window ?? {}).sort(), ['count', 'resetsAt']);
});

for (const [field, value] of [
  ['email', 'not-an-email'],
  ['email', ''],
  ['email', `${'a'.repeat(250)}@example.com`],
  ['device', 'blackberry'],
  ['language', 'fr'],
  ['pageLanguage', 'de'],
  ['knowsFounder', 'maybe'],
  ['v', 'c'],
  ['whatsappOptIn', 'true'],
] as const) {
  test(`an invalid ${field} (${JSON.stringify(value).slice(0, 24)}) is a 422 naming the field, and nothing is stored`, async () => {
    const { storage, run } = harness();
    const response = await run(post(landingBody({ [field]: value })));
    assert.equal(response.status, 422);
    const body = await json(response);
    assert.equal(body.error, 'invalid_fields');
    assert.ok((body.fields as string[]).includes(field), `fields ${JSON.stringify(body.fields)} must name ${field}`);
    assert.deepEqual(await stored(storage), []);
  });
}

test('source is lower-cased when it fits [A-Za-z0-9_-]{1,64}, and is "direct" otherwise', async () => {
  const cases: Array<[unknown, string]> = [
    ['IG-Story_1006', 'ig-story_1006'],
    ['bad source!', 'direct'],
    ['x'.repeat(65), 'direct'],
    [undefined, 'direct'],
    [42, 'direct'],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [source, expected] = cases[index]!;
    const { storage, run } = harness();
    const response = await run(post(landingBody({ email: `s${index}@example.com`, source })));
    assert.equal(response.status, 200);
    assert.equal((await stored(storage))[0]!.source, expected, `source ${JSON.stringify(source)}`);
  }
});

test('without the WhatsApp opt-in a phone number is never stored, whatever was sent', async () => {
  const { storage, run } = harness();
  const response = await run(post(landingBody({ whatsappOptIn: false, phone: '+972 50-123-4567' })));
  assert.equal(response.status, 200);
  const [record] = await stored(storage);
  assert.equal(record!.phone, null);
  assert.equal(record!.whatsappOptIn, false);
  assert.ok(!JSON.stringify(record).includes('123-4567'), 'the number must not survive anywhere in the record');
});

test('with the WhatsApp opt-in a valid number is stored, and a missing or invalid one is a 422', async () => {
  const opted = harness();
  const ok = await opted.run(post(landingBody({ whatsappOptIn: true, phone: ' +972 50-123-4567 ' })));
  assert.equal(ok.status, 200);
  const [record] = await stored(opted.storage);
  assert.equal(record!.whatsappOptIn, true);
  assert.equal(record!.phone, '+972 50-123-4567');

  for (const phone of [null, '', 'call me', '12']) {
    const { storage, run } = harness();
    const response = await run(post(landingBody({ whatsappOptIn: true, phone })));
    assert.equal(response.status, 422, `phone ${JSON.stringify(phone)}`);
    assert.ok(((await json(response)).fields as string[]).includes('phone'));
    assert.deepEqual(await stored(storage), []);
  }
});

test('a new and an already-registered email get the same answer, and the first registration is kept', async () => {
  const { storage, run } = harness();
  const first = await run(post(landingBody({ device: 'android' })));
  const again = await run(post(landingBody({ email: 'TESTER@example.com', device: 'iphone', v: 'b' })));
  assert.equal(first.status, again.status);
  assert.equal(await first.text(), await again.text());
  assert.deepEqual(Array.from(first.headers.entries()).sort(), Array.from(again.headers.entries()).sort());

  const records = await stored(storage);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.device, 'android');
  assert.equal(records[0]!.v, 'a');
});

test('a honeypot hit answers 200 and writes nothing at all, not even to the rate-limit window', async () => {
  const { storage, run } = harness();
  const response = await run(post(landingBody({ website: 'https://spam.example' })));
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true });
  assert.deepEqual(await stored(storage), []);
  assert.equal(await storage.get(RATE_LIMIT_PATH), null);
});

test('cross-site, missing and unlisted origins are refused, and an unset allow-list on Cloud Run fails closed', async () => {
  const cases: Array<[string, Request, NodeJS.ProcessEnv]> = [
    ['unlisted origin', post(landingBody(), { origin: 'https://evil.example' }), CLOUD_RUN_ENV],
    ['cross-site fetch metadata', post(landingBody(), { 'sec-fetch-site': 'cross-site' }), CLOUD_RUN_ENV],
    ['no allow-list on Cloud Run', post(landingBody()), { K_SERVICE: 'maybesitter-api' } as unknown as NodeJS.ProcessEnv],
  ];
  const noOrigin = new Request('https://api.internal.example/api/early-access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(landingBody()),
  });
  cases.push(['no Origin header', noOrigin, CLOUD_RUN_ENV]);

  for (const [label, request, env] of cases) {
    const { storage, run } = harness();
    const response = await run(request, { env });
    assert.equal(response.status, 403, label);
    assert.deepEqual(await stored(storage), [], label);
  }
});

test('off Cloud Run a same-origin request is accepted, for local previews', async () => {
  const { run } = harness();
  const request = post(landingBody(), { origin: 'https://api.internal.example' });
  const response = await run(request, { env: {} as NodeJS.ProcessEnv });
  assert.equal(response.status, 200);
});

test('only POST with a JSON body is accepted', async () => {
  const { storage, run } = harness();
  const get = await run(new Request('https://api.internal.example/api/early-access', { headers: { origin: ORIGIN } }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');

  assert.equal((await run(post('email=a@b.co', { 'content-type': 'application/x-www-form-urlencoded' }))).status, 415);
  assert.equal((await run(post('{not json'))).status, 400);
  assert.equal((await run(post('[1,2]'))).status, 400);
  assert.deepEqual(await stored(storage), []);
});

test('a body over 4 KiB is refused, whether or not it declares its length', async () => {
  const { storage, run } = harness();
  const big = JSON.stringify(landingBody({ padding: 'x'.repeat(EARLY_ACCESS_BODY_LIMIT_BYTES) }));
  assert.ok(big.length > EARLY_ACCESS_BODY_LIMIT_BYTES);
  assert.equal((await run(post(big))).status, 413);
  assert.equal((await run(post(landingBody(), { 'content-length': String(EARLY_ACCESS_BODY_LIMIT_BYTES + 1) }))).status, 413);
  assert.deepEqual(await stored(storage), []);
});

test('the global window answers 429 once full, and opens again after an hour', async () => {
  let now = NOW;
  const { storage, run } = harness({ hourlyLimit: 1, now: () => now });
  assert.equal((await run(post(landingBody({ email: 'one@example.com' })))).status, 200);
  const limited = await run(post(landingBody({ email: 'two@example.com' })));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '3600');
  assert.equal((await stored(storage)).length, 1);

  now = NOW + 60 * 60 * 1000 + 1;
  assert.equal((await run(post(landingBody({ email: 'two@example.com' })))).status, 200);
  assert.equal((await stored(storage)).length, 2);
});

test('storage trouble is a 503, never a false success', async () => {
  const failing: EarlyAccessStore = {
    allow: async () => true,
    register: async () => {
      throw new Error('UNAVAILABLE');
    },
  };
  const broken = await handleEarlyAccess(post(landingBody()), { storeFactory: () => failing, env: CLOUD_RUN_ENV });
  assert.equal(broken.status, 503);
  assert.equal(broken.headers.get('retry-after'), '30');

  const noStore = await handleEarlyAccess(post(landingBody()), {
    storeFactory: () => {
      throw new Error('early access requires durable Firestore storage');
    },
    env: CLOUD_RUN_ENV,
  });
  assert.equal(noStore.status, 503);
});

test('the exact body the landing page sends is accepted, and it carries no name', async () => {
  const script = readFileSync(join(repoRoot, 'site', 'landing.js'), 'utf8');
  const block = /var body = \{([\s\S]*?)\};/.exec(script);
  assert.ok(block, 'site/landing.js must build its request body as `var body = { … }`');
  const sent = Array.from(block[1]!.matchAll(/^\s*([A-Za-z]+):/gm), (match) => match[1]!).sort();
  assert.deepEqual(sent, Object.keys(landingBody()).sort(), 'the landing page and this test disagree on the request shape');
  assert.ok(!sent.includes('name'), 'the landing page does not collect a name');

  const { run } = harness();
  assert.equal((await run(post(landingBody()))).status, 200);
});

test('there is no page-view endpoint: no /events route, and production does not serve that path', () => {
  assert.equal(existsSync(join(repoRoot, 'src', 'app', 'api', 'early-access', 'events')), false);
  assert.equal(isProductionPath('/api/early-access/events'), false);
  assert.equal(isProductionPath('/api/early-access'), true);

  const route = readFileSync(join(repoRoot, 'src', 'app', 'api', 'early-access', 'route.ts'), 'utf8');
  const verbs = Array.from(route.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g), (m) => m[1]);
  assert.deepEqual(verbs, ['POST']);
});
