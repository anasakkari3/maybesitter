/**
 * The QA fault proxy (scripts/qa/faultProxy.mjs) is a local development tool,
 * not product code. It sits between a development build on the simulator and a
 * staging (or local) backend and fails, delays or holds chosen routes, so that
 * the 24 audit findings that need a misbehaving network can be seen
 * (docs/operations/QA_FAULT_PROXY.md).
 *
 * These tests drive it against a fake upstream on 127.0.0.1. Every server they
 * start is closed in `after`, so nothing is left listening.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertSafeTarget, controlTokenPath, startFaultProxy } from '../../scripts/qa/faultProxy.mjs';
import { parseCtlArgs, readControlToken } from '../../scripts/qa/faultProxyCtl.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGING = 'https://maybesitter-api-staging-xw5vhndxxq-ew.a.run.app';

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };
type Hit = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

// --- fake upstream ----------------------------------------------------------

const hits: Hit[] = [];
const upstreamClosed: string[] = [];
let upstream: http.Server;
let upstreamUrl = '';

function listen(server: http.Server, host = '127.0.0.1'): Promise<number> {
  return new Promise((done) => server.listen(0, host, () => done((server.address() as { port: number }).port)));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
}

before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url?.startsWith('/hang')) {
      // Never answers; records whether the proxy gave up on it.
      req.on('close', () => upstreamClosed.push(req.url ?? ''));
      hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' });
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ upstream: true, method: req.method, url: req.url }));
    });
  });
  upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;
});

after(async () => {
  await closeServer(upstream);
});

// --- one proxy per test -----------------------------------------------------

type Proxy = Awaited<ReturnType<typeof startFaultProxy>>;
let proxy: Proxy | null = null;

beforeEach(async () => {
  hits.length = 0;
  upstreamClosed.length = 0;
  if (proxy) await proxy.close();
  proxy = await startFaultProxy({ target: upstreamUrl, port: 0, controlPort: 0 });
});

after(async () => {
  if (proxy) await proxy.close();
  proxy = null;
});

function request(
  port: number,
  method: string,
  path: string,
  options: { body?: string; headers?: Record<string, string>; host?: string } = {},
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = http.request(
      { host: options.host ?? '127.0.0.1', port, method, path, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', fail);
      },
    );
    req.on('error', fail);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const viaProxy = (method: string, path: string, options?: Parameters<typeof request>[3]) =>
  request(proxy!.port, method, path, options);

async function control(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json', 'x-qa-token': proxy!.controlToken },
): Promise<{ status: number; json: any }> {
  const reply = await request(proxy!.controlPort, method, path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
  return { status: reply.status, json: reply.body === '' ? null : JSON.parse(reply.body) };
}

const addRule = async (rule: Record<string, unknown>) => {
  const reply = await control('POST', '/rules', rule);
  assert.equal(reply.status, 201, `rule refused: ${JSON.stringify(reply.json)}`);
  return reply.json.rule as { id: string };
};

/** A Firebase-shaped ID token. Only its payload is meaningful here. */
function fakeIdToken(uid: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', kid: 'k' })}.${part({ user_id: uid, sub: uid })}.c2lnbmF0dXJlLXNlY3JldA`;
}

// --- pass-through -------------------------------------------------------------

test('without rules every request reaches the target unchanged', async () => {
  const reply = await viaProxy('POST', '/api/mobile/capture?x=1', { body: '{"a":1}', headers: { 'content-type': 'application/json' } });
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), { upstream: true, method: 'POST', url: '/api/mobile/capture?x=1' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.body, '{"a":1}');
});

test('an absolute-form request URL cannot send the proxy to another host', async () => {
  const reply = await viaProxy('GET', 'http://evil.invalid/api/mobile/today');
  assert.equal(reply.status, 200);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.url, '/api/mobile/today');
});

// --- fail -----------------------------------------------------------------

test('fail answers with the chosen status and body, and the request never reaches the target', async () => {
  await addRule({ action: 'fail', method: '^GET$', path: '^/api/mobile/football$', status: 503, body: '{"error":"down"}' });
  const failed = await viaProxy('GET', '/api/mobile/football');
  assert.equal(failed.status, 503);
  assert.deepEqual(JSON.parse(failed.body), { error: 'down' });
  assert.equal(hits.length, 0);

  const other = await viaProxy('PUT', '/api/mobile/football');
  assert.equal(other.status, 200, 'the rule matched a method it does not name');
  const otherPath = await viaProxy('GET', '/api/mobile/football/fixtures');
  assert.equal(otherPath.status, 200, 'the rule matched a path it does not name');
  assert.equal(hits.length, 2);
});

test('fail with drop closes the connection without an answer', async () => {
  await addRule({ action: 'fail', path: '^/api/mobile/next-step', drop: true });
  await assert.rejects(viaProxy('POST', '/api/mobile/next-step', { body: '{}' }), /socket hang up|ECONNRESET/);
  assert.equal(hits.length, 0);
  const log = await control('GET', '/log');
  assert.equal(log.json.entries.at(-1).outcome, 'dropped');
});

// --- delay ----------------------------------------------------------------

test('delay holds the request for the given milliseconds, then forwards it', async () => {
  await addRule({ action: 'delay', path: '^/api/mobile/commitments', ms: 250 });
  const started = Date.now();
  const reply = await viaProxy('GET', '/api/mobile/commitments');
  const took = Date.now() - started;
  assert.equal(reply.status, 200);
  assert.ok(took >= 240, `answered after ${took} ms`);
  assert.equal(hits.length, 1);
  const log = await control('GET', '/log');
  assert.ok(log.json.entries.at(-1).durationMs >= 240);
});

// --- hold -----------------------------------------------------------------

test('hold keeps the answer until it is released by hand', async () => {
  const rule = await addRule({ action: 'hold', path: '^/api/mobile/habits$' });
  let settled = false;
  const pending = viaProxy('POST', '/api/mobile/habits', { body: '{}' }).then((reply) => {
    settled = true;
    return reply;
  });
  await waitFor(async () => (await control('GET', '/held')).json.held.length === 1);
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(settled, false, 'a held answer was delivered before it was released');

  const released = await control('POST', '/release', { ruleId: rule.id });
  assert.equal(released.json.released, 1);
  const reply = await pending;
  assert.equal(reply.status, 200);
  assert.equal(JSON.parse(reply.body).upstream, true);
  assert.equal((await control('GET', '/held')).json.held.length, 0);
});

test('hold with a status never reaches the target and answers that status on release', async () => {
  await addRule({ action: 'hold', path: '^/api/mobile/weekly-blocks', status: 401, body: '{"error":"unauthenticated"}' });
  const pending = viaProxy('POST', '/api/mobile/weekly-blocks', { body: '{"title":"x"}' });
  await waitFor(async () => (await control('GET', '/held')).json.held.length === 1);
  await control('POST', '/release', {});
  const reply = await pending;
  assert.equal(reply.status, 401);
  assert.equal(hits.length, 0);
});

// --- once / count -----------------------------------------------------------

test('once applies a rule to the first matching request only', async () => {
  await addRule({ action: 'fail', path: '^/api/mobile/today$', status: 500, once: true });
  assert.equal((await viaProxy('GET', '/api/mobile/today')).status, 500);
  assert.equal((await viaProxy('GET', '/api/mobile/today')).status, 200);
});

test('times applies a rule to that many matching requests, then lets them through', async () => {
  await addRule({ action: 'fail', path: '^/api/mobile/today$', status: 500, times: 2 });
  assert.equal((await viaProxy('GET', '/api/mobile/today')).status, 500);
  assert.equal((await viaProxy('GET', '/api/mobile/today')).status, 500);
  assert.equal((await viaProxy('GET', '/api/mobile/today')).status, 200);
  const rules = await control('GET', '/rules');
  assert.equal(rules.json.rules[0].remaining, 0);
});

// --- control API ------------------------------------------------------------

test('the control API adds, lists, removes and clears rules, and refuses a bad one', async () => {
  const first = await addRule({ action: 'fail', path: '^/a', status: 500 });
  await addRule({ action: 'delay', path: '^/b', ms: 10 });
  assert.equal((await control('GET', '/rules')).json.rules.length, 2);

  assert.equal((await control('DELETE', `/rules/${first.id}`)).status, 200);
  assert.equal((await control('GET', '/rules')).json.rules.length, 1);

  assert.equal((await control('DELETE', '/rules')).status, 200);
  assert.equal((await control('GET', '/rules')).json.rules.length, 0);

  for (const bad of [
    { action: 'explode', path: '^/a' },
    { action: 'fail', path: '(' },
    { action: 'fail', path: '^/a', status: 42 },
    { action: 'fail', path: '^/a', status: 199 },
    { action: 'fail', path: '^/a', status: 100 },
    { action: 'delay', path: '^/a' },
    { action: 'fail', path: '^/a', times: 0 },
  ]) {
    assert.equal((await control('POST', '/rules', bad)).status, 400, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the request log records time, method, path, status and duration', async () => {
  await addRule({ action: 'fail', path: '^/api/mobile/settings/categories$', status: 503 });
  await viaProxy('GET', '/api/mobile/settings/categories');
  await viaProxy('GET', '/api/mobile/today?day=1');
  const { entries } = (await control('GET', '/log')).json;
  assert.equal(entries.length, 2);
  const [failed, passed] = entries;
  assert.equal(failed.method, 'GET');
  assert.equal(failed.path, '/api/mobile/settings/categories');
  assert.equal(failed.status, 503);
  assert.equal(failed.action, 'fail');
  assert.ok(!Number.isNaN(Date.parse(failed.time)));
  assert.equal(typeof failed.durationMs, 'number');
  assert.equal(passed.status, 200);
  assert.equal(passed.path, '/api/mobile/today?day=1');
  assert.equal(passed.action, null);

  await control('DELETE', '/log');
  assert.equal((await control('GET', '/log')).json.entries.length, 0);
});

test('the control API refuses a request whose Host is not loopback', async () => {
  const reply = await request(proxy!.controlPort, 'GET', '/rules', { headers: { host: 'attacker.example:80', 'x-qa-token': proxy!.controlToken } });
  assert.equal(reply.status, 403);
});

// --- authorization never reaches a log or a file ------------------------------

test('the Authorization token is never written to the log or a body file', async () => {
  const token = fakeIdToken('uid-account-a');
  const bodies = await control('POST', '/bodies', { enabled: true });
  assert.equal(bodies.status, 200);
  const dir: string = bodies.json.dir;

  await addRule({ action: 'fail', path: '^/api/mobile/pilot/trust$', status: 500 });
  await viaProxy('POST', '/api/mobile/pilot/trust', {
    body: JSON.stringify({ answer: 'yes', idToken: token, nested: { refreshToken: 'r-secret' } }),
    headers: { authorization: `Bearer ${token}`, cookie: 'session=s-secret', 'content-type': 'application/json', 'idempotency-key': 'key-1' },
  });
  await viaProxy('GET', '/api/mobile/today', { headers: { authorization: `Bearer ${token}` } });

  // The upstream still receives the real header: redaction is for the record only.
  assert.equal(hits[0]!.headers.authorization, `Bearer ${token}`);

  const log = await control('GET', '/log');
  const logText = JSON.stringify(log.json);
  assert.ok(!logText.includes(token), 'the log holds the token');
  assert.ok(!logText.includes(token.split('.')[2]!), 'the log holds the token signature');
  assert.equal(log.json.entries[0].authUid, 'uid-account-a', 'the log should say which account sent the request');

  const files = readdirSync(dir);
  assert.equal(files.length, 2);
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8');
    assert.ok(!text.includes(token), `${name} holds the token`);
    assert.ok(!text.includes('r-secret'), `${name} holds a refresh token`);
    assert.ok(!text.includes('s-secret'), `${name} holds a cookie`);
  }
  const record = JSON.parse(readFileSync(join(dir, files.sort()[0]!), 'utf8'));
  assert.equal(record.headers.authorization, 'مخفي');
  assert.equal(record.headers['idempotency-key'], 'key-1', 'the idempotency key is evidence, not a secret');
  assert.equal(record.body.answer, 'yes');
  assert.equal(record.body.idToken, 'مخفي');
  assert.equal(record.body.nested.refreshToken, 'مخفي');
});

test('request bodies are written outside the repository, and a directory inside it is refused', async () => {
  const bodies = await control('POST', '/bodies', { enabled: true });
  const dir = resolve(bodies.json.dir);
  assert.ok(!dir.startsWith(ROOT), `bodies would be written inside the repository (${dir})`);
  assert.ok(dir.startsWith(resolve(tmpdir())), `bodies are not under the temp dir (${dir})`);
  assert.ok(existsSync(dir));

  await assert.rejects(
    startFaultProxy({ target: upstreamUrl, port: 0, controlPort: 0, bodyDir: join(ROOT, 'tmp-bodies') }),
    /outside the repository/,
  );
});

// --- the target must be staging or local ------------------------------------

test('a production or unknown target is refused', async () => {
  for (const target of [
    'https://maybesitter-api-xw5vhndxxq-ew.a.run.app',
    'https://maybesitter-api-production-xw5vhndxxq-ew.a.run.app',
    'https://maybesitter.com',
    'https://maybesitter-app.web.app',
    'https://example.com',
    'http://maybesitter-api-staging-xw5vhndxxq-ew.a.run.app',
    'https://maybesitter-api-staging-xw5vhndxxq-ew.a.run.app.evil.com',
    'ftp://localhost',
    'https://pr-12---maybesitter-api-staging-xw5vhndxxq-ew.a.run.app',
    'https://maybesitter-api-staging-otherproject-ew.a.run.app',
    'https://maybesitter-api-staging-xw5vhndxxq-uc.a.run.app',
    'https://maybesitter-api-staging-123456.europe-west1.run.app',
    'not a url',
  ]) {
    assert.throws(() => assertSafeTarget(target), /refus/i, `accepted ${target}`);
  }
  for (const target of [
    STAGING,
    'https://sha-1a2b3c4---maybesitter-api-staging-xw5vhndxxq-ew.a.run.app',
    'https://qa-d2---maybesitter-api-staging-xw5vhndxxq-ew.a.run.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
  ]) {
    assert.doesNotThrow(() => assertSafeTarget(target), `refused ${target}`);
  }
  await assert.rejects(
    startFaultProxy({ target: 'https://maybesitter-api-xw5vhndxxq-ew.a.run.app', port: 0, controlPort: 0 }),
    /refus/i,
  );
});

test('the command line refuses a production target and exits non-zero', () => {
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts/qa/faultProxy.mjs'), '--target', 'https://maybesitter-api-xw5vhndxxq-ew.a.run.app', '--port', '0', '--control-port', '0'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /refus/i);
});

// --- loopback only ------------------------------------------------------------

test('both the proxy and the control API listen on 127.0.0.1 only', async () => {
  assert.equal(proxy!.host, '127.0.0.1');
  assert.equal(proxy!.addresses.proxy, '127.0.0.1');
  assert.equal(proxy!.addresses.control, '127.0.0.1');

  const external = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
  if (!external) return; // no non-loopback interface on this machine: the address check above is the proof
  for (const port of [proxy!.port, proxy!.controlPort]) {
    await assert.rejects(request(port, 'GET', '/rules', { host: external.address }), /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT/);
  }
});

test('startFaultProxy takes no host option, so it cannot be bound elsewhere', async () => {
  await assert.rejects(
    startFaultProxy({ target: upstreamUrl, port: 0, controlPort: 0, host: '0.0.0.0' } as never),
    /127\.0\.0\.1/,
  );
});

// --- the control command line ---------------------------------------------------

test('the control command line turns arguments into rules', () => {
  assert.deepEqual(parseCtlArgs(['fail', 'GET', '^/api/mobile/football$', '--status', '503', '--once']), {
    command: 'fail',
    controlPort: 8788,
    rule: { action: 'fail', method: '^GET$', path: '^/api/mobile/football$', status: 503, once: true },
  });
  assert.deepEqual(parseCtlArgs(['--control-port', '9999', 'delay', '*', '^/api/mobile/commitments', '3000', '--times', '2']), {
    command: 'delay',
    controlPort: 9999,
    rule: { action: 'delay', method: '.*', path: '^/api/mobile/commitments', ms: 3000, times: 2 },
  });
  assert.deepEqual(parseCtlArgs(['hold', 'POST', '^/api/mobile/habits$', '--status', '401']), {
    command: 'hold',
    controlPort: 8788,
    rule: { action: 'hold', method: '^POST$', path: '^/api/mobile/habits$', status: 401 },
  });
  assert.deepEqual(parseCtlArgs(['fail', 'POST', '^/api/mobile/next-step', '--drop']).rule, {
    action: 'fail', method: '^POST$', path: '^/api/mobile/next-step', drop: true,
  });
  assert.equal(parseCtlArgs(['release']).command, 'release');
  assert.throws(() => parseCtlArgs(['explode']), /unknown command/);
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('timed out waiting');
}

// --- review fixes ---------------------------------------------------------------

/** Sends a raw request line, so a request target node would not build itself can be tried. */
function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((done, fail) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let out = '';
    socket.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    socket.on('end', () => done(out));
    socket.on('error', fail);
    socket.setTimeout(3000, () => {
      socket.destroy();
      done(out);
    });
  });
}

test('a malformed request target is answered 400 and the proxy keeps working', async () => {
  for (const port of [proxy!.port, proxy!.controlPort]) {
    const reply = await rawRequest(port, 'GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.match(reply, /^HTTP\/1\.1 400/, `port ${port} answered ${JSON.stringify(reply.slice(0, 40))}`);
  }
  assert.equal((await viaProxy('GET', '/api/mobile/today')).status, 200);
  assert.equal((await control('GET', '/rules')).status, 200);
});

test('the control API needs the start-up token, a JSON content type and no Origin', async () => {
  const token = proxy!.controlToken;
  assert.match(token, /^[0-9a-f]{32,}$/);
  const json = { 'content-type': 'application/json' };
  const rule = { action: 'fail', path: '^/a' };

  assert.equal((await control('GET', '/rules', undefined, {})).status, 401, 'no token');
  assert.equal((await control('GET', '/rules', undefined, { 'x-qa-token': 'wrong' })).status, 401, 'wrong token');
  assert.equal((await control('POST', '/rules', rule, json)).status, 401, 'no token on a write');
  assert.equal(
    (await control('POST', '/rules', rule, { ...json, 'x-qa-token': token, origin: 'https://evil.example' })).status,
    403,
    'a request with an Origin header',
  );
  assert.equal(
    (await control('POST', '/rules', rule, { 'content-type': 'text/plain', 'x-qa-token': token })).status,
    415,
    'a write without a JSON content type',
  );
  assert.equal((await control('DELETE', '/rules', undefined, { 'x-qa-token': token })).status, 415, 'a delete without a JSON content type');
  assert.equal((await control('GET', '/rules')).json.rules.length, 0, 'a refused request changed the rules');
  assert.equal((await control('POST', '/rules', rule)).status, 201);
});

test('the token is written to a 0600 file in the temp dir, and the command line reads it', async () => {
  const file = controlTokenPath(proxy!.controlPort);
  assert.ok(resolve(file).startsWith(resolve(tmpdir())), `token file outside the temp dir: ${file}`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, 'utf8').trim(), proxy!.controlToken);
  assert.equal(readControlToken(proxy!.controlPort), proxy!.controlToken);
  const port = proxy!.controlPort;
  await proxy!.close();
  proxy = null;
  assert.equal(existsSync(file), false, 'the token file outlives the proxy');
  assert.equal(existsSync(controlTokenPath(port)), false);
});

test('rule expressions and the number of rules are bounded', async () => {
  assert.equal((await control('POST', '/rules', { action: 'fail', path: `^/${'a'.repeat(600)}` })).status, 400);
  assert.equal((await control('POST', '/rules', { action: 'fail', method: 'G'.repeat(600), path: '^/a' })).status, 400);
  for (let i = 0; i < 100; i += 1) {
    assert.equal((await control('POST', '/rules', { action: 'fail', path: `^/r${i}$` })).status, 201);
  }
  assert.equal((await control('POST', '/rules', { action: 'fail', path: '^/one-too-many$' })).status, 400);
});

test('secret query parameters are hidden in the log and the body file', async () => {
  const bodies = await control('POST', '/bodies', { enabled: true });
  await viaProxy('GET', '/api/mobile/oauth/callback?code=CODE-SECRET&access_token=AT-SECRET&token=T-SECRET&key=K-SECRET&day=2026-11-19');
  assert.match(hits[0]!.url, /code=CODE-SECRET/, 'the target must still receive the real query');
  const logText = JSON.stringify((await control('GET', '/log')).json);
  const fileText = readdirSync(bodies.json.dir).map((name) => readFileSync(join(bodies.json.dir, name), 'utf8')).join('\n');
  for (const text of [logText, fileText]) {
    for (const secret of ['CODE-SECRET', 'AT-SECRET', 'T-SECRET', 'K-SECRET']) {
      assert.ok(!text.includes(secret), `${secret} was written`);
    }
    assert.ok(text.includes('day=2026-11-19'), 'an ordinary parameter was hidden');
  }
});

test('secret-named fields are hidden in JSON and form-urlencoded bodies', async () => {
  const bodies = await control('POST', '/bodies', { enabled: true });
  const secretFields = ['apiKey', 'api_key', 'oobCode', 'assertion', 'jwt', 'otp', 'session', 'password', 'secret'];
  const json: Record<string, string> = { title: 'keep me', idempotencyKey: 'idem-1' };
  for (const field of secretFields) json[field] = `${field}-VALUE`;
  await viaProxy('POST', '/api/mobile/one', { body: JSON.stringify(json), headers: { 'content-type': 'application/json' } });
  await viaProxy('POST', '/api/mobile/two', {
    body: 'grant_type=jwt-bearer&assertion=ASSERT-VALUE&client_secret=CS-VALUE&oobCode=OOB-VALUE&title=keep',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const [first, second] = readdirSync(bodies.json.dir).sort().map((name) => JSON.parse(readFileSync(join(bodies.json.dir, name), 'utf8')));
  for (const field of secretFields) assert.equal(first.body[field], 'مخفي', `${field} was written`);
  assert.equal(first.body.title, 'keep me');
  assert.equal(first.body.idempotencyKey, 'idem-1');
  const secondText = JSON.stringify(second);
  for (const secret of ['ASSERT-VALUE', 'CS-VALUE', 'OOB-VALUE']) assert.ok(!secondText.includes(secret), `${secret} was written`);
  assert.equal(second.body.title, 'keep');
  assert.equal(second.body.grant_type, 'jwt-bearer');
});

test('a body directory reached through a symlink, another case, or a sibling checkout is refused', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'fp-link-'));
  const link = join(outside, 'into-repo');
  symlinkSync(ROOT, link);
  const sibling = join(dirname(ROOT), 'some-other-checkout', 'bodies');
  const shouted = join(ROOT.replace(/[a-z]/g, (c) => c.toUpperCase()), 'tmp-bodies');
  for (const bodyDir of [join(link, 'bodies'), join(link, 'new', 'deeper'), shouted, sibling]) {
    await assert.rejects(
      startFaultProxy({ target: upstreamUrl, port: 0, controlPort: 0, bodyDir }),
      /outside the repository/,
      `accepted ${bodyDir}`,
    );
  }
  const fine = join(outside, 'bodies');
  mkdirSync(fine);
  const ok = await startFaultProxy({ target: upstreamUrl, port: 0, controlPort: 0, bodyDir: fine });
  await ok.close();
});

test('a delay is cancelled when the client goes away', async () => {
  await addRule({ action: 'delay', path: '^/api/mobile/slow$', ms: 300 });
  const req = http.request({ host: '127.0.0.1', port: proxy!.port, method: 'GET', path: '/api/mobile/slow' });
  req.on('error', () => {});
  req.end();
  await new Promise((done) => setTimeout(done, 50));
  req.destroy();
  await new Promise((done) => setTimeout(done, 450));
  assert.equal(hits.length, 0, 'the delayed request was still forwarded after the client left');
});

test('a delay is cancelled when the proxy closes', async () => {
  await addRule({ action: 'delay', path: '^/api/mobile/slow$', ms: 300 });
  viaProxy('GET', '/api/mobile/slow').catch(() => {});
  await new Promise((done) => setTimeout(done, 50));
  await proxy!.close();
  proxy = null;
  await new Promise((done) => setTimeout(done, 450));
  assert.equal(hits.length, 0, 'the delayed request was still forwarded after close');
});

test('the upstream request is aborted when the client goes away', async () => {
  const req = http.request({ host: '127.0.0.1', port: proxy!.port, method: 'GET', path: '/hang/client-left' });
  req.on('error', () => {});
  req.end();
  await waitFor(async () => hits.length === 1);
  req.destroy();
  await waitFor(async () => upstreamClosed.includes('/hang/client-left'));
});

test('an upstream that never answers gets 504 after the upstream timeout', async () => {
  await proxy!.close();
  proxy = await startFaultProxy({ target: upstreamUrl, port: 0, controlPort: 0, upstreamTimeoutMs: 150 });
  const started = Date.now();
  const reply = await viaProxy('GET', '/hang/forever');
  assert.equal(reply.status, 504);
  assert.ok(Date.now() - started < 2000);
  await waitFor(async () => upstreamClosed.includes('/hang/forever'));
});

test('a target with a path keeps that path in front of every request', async () => {
  await proxy!.close();
  proxy = await startFaultProxy({ target: `${upstreamUrl}/base/`, port: 0, controlPort: 0 });
  await viaProxy('GET', '/api/mobile/today?x=1');
  assert.equal(hits[0]!.url, '/base/api/mobile/today?x=1');
});
