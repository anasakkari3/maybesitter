#!/usr/bin/env node
// QA fault proxy — a LOCAL DEVELOPMENT TOOL, not product code.
//
// A reverse proxy between a development build on the simulator and a staging
// (or local) backend. Rules fail, delay or hold chosen routes so that the
// audit findings that need a misbehaving network can be seen
// (docs/operations/QA_FAULT_PROXY.md, evidence row "Proxy / client-side fault
// injection").
//
//   node scripts/qa/faultProxy.mjs --target <staging-or-local-url> \
//     [--port 8787] [--control-port 8788] [--log-bodies] [--body-dir <dir>]
//
// Safety, enforced here rather than documented:
//   - the target must be local (localhost, 127.0.0.1, ::1) or the staging Cloud
//     Run service (exact host, optionally a sha-/qa- revision tag) over https;
//     anything else, production included, is refused;
//   - both servers bind 127.0.0.1 and nothing else;
//   - the control API wants a per-run token (X-QA-Token, also written to a
//     0600 file in the temp dir), a JSON content type on writes, a loopback
//     Host and no Origin header, so a web page cannot drive it;
//   - the Authorization header, cookies, secret-named headers, body fields and
//     query parameters are never written to the log or a body file («مخفي»);
//   - request bodies are written only when asked, to a directory outside every
//     checkout of the repository.
//
// Only Node built-ins; no dependency.
import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const REDACTED = 'مخفي';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// The one staging service, optionally behind a sha-… or qa-… revision tag.
const STAGING_HOST = /^(?:(?:sha|qa)-[a-z0-9-]+---)?maybesitter-api-staging-xw5vhndxxq-ew\.a\.run\.app$/;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_CONTROL_BODY_BYTES = 256 * 1024;
const MAX_LOG = 2000;
const MAX_RULES = 100;
const MAX_PATTERN_LENGTH = 500;
const MAX_RULE_BODY = 64 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const ACTIONS = new Set(['fail', 'delay', 'hold']);
const SECRET_PARTS = [
  'token', 'password', 'passwd', 'secret', 'authorization', 'cookie', 'credential', 'codeverifier',
  'apikey', 'oobcode', 'assertion', 'jwt', 'session', 'appcheck', 'signature',
];
const SECRET_EXACT = new Set(['code', 'key', 'otp', 'sig', 'pin']);
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host',
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** True when a header, field or query name looks like it carries a secret. */
export function isSecretName(name) {
  const flat = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SECRET_EXACT.has(flat) || flat.endsWith('otp')) return true;
  return SECRET_PARTS.some((part) => flat.includes(part));
}

/** Throws unless `raw` is a local URL or the staging service over https. */
export function assertSafeTarget(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`fault proxy refuses target ${JSON.stringify(raw)}: not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`fault proxy refuses target ${url.href}: only http or https`);
  }
  const host = url.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return url;
  if (url.protocol === 'https:' && STAGING_HOST.test(host)) return url;
  throw new Error(
    `fault proxy refuses target ${url.origin}: only a local backend or the staging service (https://maybesitter-api-staging-xw5vhndxxq-ew.a.run.app, or its sha-/qa- tags). Production is never a target.`,
  );
}

/** Where the control token for a port is written: a 0600 file in the temp dir. */
export function controlTokenPath(controlPort) {
  return join(tmpdir(), 'maybesitter-fault-proxy-ctl', `${controlPort}.token`);
}

function compile(source, field) {
  if (typeof source !== 'string' || source === '') throw new Error(`${field} must be a non-empty regular expression`);
  if (source.length > MAX_PATTERN_LENGTH) throw new Error(`${field} is longer than ${MAX_PATTERN_LENGTH} characters`);
  try {
    return new RegExp(source);
  } catch (error) {
    throw new Error(`${field} is not a valid regular expression: ${error.message}`);
  }
}

let ruleSeq = 0;

/** Validates a rule as posted to the control API and returns the stored form. */
export function normalizeRule(input) {
  if (!input || typeof input !== 'object') throw new Error('a rule must be a JSON object');
  const { action } = input;
  if (!ACTIONS.has(action)) throw new Error(`action must be fail, delay or hold (got ${JSON.stringify(action)})`);
  const method = input.method === undefined || input.method === '*' ? '.*' : input.method;
  const rule = {
    id: `r${++ruleSeq}`,
    action,
    method,
    path: input.path,
    methodRe: compile(method, 'method'),
    pathRe: compile(input.path, 'path'),
    status: null,
    body: null,
    drop: false,
    ms: null,
    remaining: null,
    hits: 0,
  };
  if (input.status !== undefined) {
    if (!Number.isInteger(input.status) || input.status < 200 || input.status > 599) {
      throw new Error('status must be an integer between 200 and 599');
    }
    rule.status = input.status;
  }
  if (input.body !== undefined) {
    if (typeof input.body !== 'string' || input.body.length > MAX_RULE_BODY) {
      throw new Error(`body must be a string of at most ${MAX_RULE_BODY} characters`);
    }
    rule.body = input.body;
  }
  if (action === 'fail') {
    rule.drop = input.drop === true;
    if (!rule.drop && rule.status === null) rule.status = 503;
  }
  if (action === 'delay') {
    if (!Number.isInteger(input.ms) || input.ms < 0 || input.ms > 600_000) {
      throw new Error('delay needs ms, an integer from 0 to 600000');
    }
    rule.ms = input.ms;
  }
  if (input.once === true) rule.remaining = 1;
  if (input.times !== undefined) {
    if (!Number.isInteger(input.times) || input.times < 1) throw new Error('times must be a positive integer');
    rule.remaining = input.times;
  }
  return rule;
}

function publicRule(rule) {
  const { methodRe, pathRe, ...rest } = rule;
  return rest;
}

/** Which account sent the request: the uid claim of a Firebase ID token. Never the token. */
function bearerUid(header) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(header ?? '');
  if (!match) return null;
  const parts = match[1].split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const uid = payload.user_id ?? payload.sub;
    return typeof uid === 'string' ? uid : null;
  } catch {
    return null;
  }
}

function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSecretName(name) ? REDACTED : value;
  }
  return out;
}

function redactValue(value, secrets) {
  if (typeof value === 'string') {
    return secrets.some((secret) => secret !== '' && value.includes(secret)) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSecretName(key) ? REDACTED : redactValue(item, secrets);
    }
    return out;
  }
  return value;
}

/** The path with every secret-named query value replaced; for the record only. */
function redactPath(pathname, search) {
  if (search === '') return pathname;
  const params = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const [name, value] of params) out.append(name, isSecretName(name) ? REDACTED : value);
  return `${pathname}?${out.toString()}`;
}

function redactBody(buffer, contentType, secrets) {
  if (buffer.length === 0) return null;
  const text = buffer.toString('utf8');
  if (/application\/x-www-form-urlencoded/i.test(contentType ?? '')) {
    const out = {};
    for (const [name, value] of new URLSearchParams(text)) out[name] = isSecretName(name) ? REDACTED : redactValue(value, secrets);
    return out;
  }
  try {
    return redactValue(JSON.parse(text), secrets);
  } catch {
    let out = text;
    for (const secret of secrets) if (secret !== '') out = out.split(secret).join(REDACTED);
    return out;
  }
}

/** The real path of `dir`, resolving symlinks through its nearest existing ancestor. */
function realPathOf(dir) {
  let current = resolve(dir);
  const rest = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  let real = current;
  try {
    real = realpathSync(current);
  } catch {
    // keep the resolved path
  }
  return join(real, ...rest);
}

/**
 * Directories a body file must never land in: this checkout, the main
 * checkout that owns the shared git directory, and the folder that holds them
 * both (all sibling worktrees).
 */
function forbiddenRoots() {
  const roots = [REPO_ROOT];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const mainCheckout = dirname(common);
    roots.push(mainCheckout);
    // The deepest folder that contains both this checkout and the main one.
    const a = realPathOf(REPO_ROOT).split(sep);
    const b = realPathOf(mainCheckout).split(sep);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    const shared = a.slice(0, i).join(sep) || sep;
    if (shared.split(sep).filter(Boolean).length >= 2) roots.push(shared);
  } catch {
    roots.push(dirname(REPO_ROOT));
  }
  return roots.map((root) => realPathOf(root).toLowerCase());
}

function insideRepo(dir) {
  const real = realPathOf(dir).toLowerCase();
  return forbiddenRoots().some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep));
}

function listenOn(server, port) {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, HOST, () => {
      server.off('error', fail);
      done(server.address());
    });
  });
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

function sendJson(res, status, value) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(value, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

/** Parses a request target; a malformed one is a 400, never a crash. */
function parseTarget(raw) {
  try {
    return new URL(raw ?? '/', 'http://local.invalid');
  } catch {
    throw new HttpError(400, 'malformed request target');
  }
}

/** Wraps a request handler so that nothing it throws can take the process down. */
function guarded(handler) {
  return (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        try {
          sendJson(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'fault proxy error' });
        } catch {
          res.destroy();
        }
      });
  };
}

/** A malformed request line never reaches a handler: answer 400 on the socket. */
function answerClientErrors(server) {
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
}

/**
 * Starts the proxy and its control API. Both bind 127.0.0.1; there is no host
 * option. `port`/`controlPort` 0 picks a free port.
 */
export async function startFaultProxy(options = {}) {
  if ('host' in options && options.host !== HOST) {
    throw new Error(`fault proxy listens on ${HOST} only`);
  }
  const target = assertSafeTarget(options.target);
  if (options.bodyDir !== undefined && insideRepo(options.bodyDir)) {
    throw new Error(`body directory must be outside the repository (${resolve(options.bodyDir)})`);
  }
  const transport = target.protocol === 'https:' ? https : http;
  const basePath = target.pathname.replace(/\/+$/, '');
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const controlToken = randomBytes(24).toString('hex');
  const controlTokenBuffer = Buffer.from(controlToken);

  const rules = [];
  const held = new Map();
  const timers = new Set();
  const log = [];
  let seq = 0;
  let closed = false;
  let bodyDir = options.bodyDir === undefined ? null : resolve(options.bodyDir);
  let bodiesEnabled = options.logBodies === true;

  const ensureBodyDir = () => {
    if (bodyDir === null) bodyDir = mkdtempSync(join(tmpdir(), 'maybesitter-fault-proxy-'));
    mkdirSync(bodyDir, { recursive: true, mode: 0o700 });
    return bodyDir;
  };
  if (bodiesEnabled) ensureBodyDir();

  const matchRule = (method, pathname) => {
    for (const rule of rules) {
      if (rule.remaining === 0) continue;
      if (!rule.methodRe.test(method) || !rule.pathRe.test(pathname)) continue;
      if (rule.remaining !== null) rule.remaining -= 1;
      rule.hits += 1;
      return rule;
    }
    return null;
  };

  const writeBodyRecord = (entry, headers, body, secrets) => {
    const dir = ensureBodyDir();
    const safePath = entry.path.split('?')[0].replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 80);
    const name = `${String(entry.seq).padStart(5, '0')}-${entry.method}${safePath}.json`;
    const record = {
      time: entry.time,
      method: entry.method,
      path: entry.path,
      authUid: entry.authUid,
      headers: redactHeaders(headers),
      body: redactBody(body, headers['content-type'], secrets),
    };
    writeFileSync(join(dir, name), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  };

  const proxyServer = http.createServer(guarded(async (req, res) => {
    const started = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    // Only the path and query of the request are used: an absolute-form URL
    // cannot point the proxy at another host.
    const local = parseTarget(req.url);
    const pathWithQuery = `${local.pathname}${local.search}`;
    const entry = {
      seq: ++seq,
      time: new Date(started).toISOString(),
      method,
      path: redactPath(local.pathname, local.search),
      status: null,
      durationMs: null,
      action: null,
      ruleId: null,
      outcome: 'pending',
      auth: req.headers.authorization ? REDACTED : 'none',
      authUid: bearerUid(req.headers.authorization),
    };
    log.push(entry);
    if (log.length > MAX_LOG) log.shift();
    const finish = (status, outcome) => {
      if (entry.durationMs !== null) return;
      entry.status = status;
      entry.outcome = outcome;
      entry.durationMs = Date.now() - started;
    };

    // Everything that is still pending for this request: a delay timer, an
    // upstream request. Cancelled when the client leaves or the proxy closes.
    const cleanups = new Set();
    res.on('close', () => {
      if (!res.writableFinished) finish(null, 'client_gone');
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
    });

    let body;
    try {
      body = await readBody(req);
    } catch {
      finish(null, 'client_error');
      res.destroy();
      return;
    }
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (bodiesEnabled) {
      try {
        writeBodyRecord(entry, req.headers, body, [token]);
      } catch {
        entry.bodyRecord = 'write_failed';
      }
    }

    const rule = matchRule(method, local.pathname);
    if (rule) {
      entry.action = rule.action;
      entry.ruleId = rule.id;
    }

    const answerWith = (status, text) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-fault-proxy': rule?.id ?? 'pass' });
      res.end(text ?? JSON.stringify({ error: 'fault_proxy', status }));
      finish(status, 'injected');
    };

    const forward = (onResponse) => {
      if (closed || res.destroyed) return;
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
      }
      headers.host = target.host;
      headers['content-length'] = String(body.length);
      const upstreamReq = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname.replace(/^\[|\]$/g, ''),
          port: target.port || undefined,
          method,
          path: `${basePath}${pathWithQuery}`,
          headers,
        },
        onResponse,
      );
      const abort = () => upstreamReq.destroy();
      cleanups.add(abort);
      upstreamReq.on('close', () => cleanups.delete(abort));
      upstreamReq.setTimeout(upstreamTimeoutMs, () => {
        upstreamReq.destroy(new HttpError(504, `upstream did not answer within ${upstreamTimeoutMs} ms`));
      });
      upstreamReq.on('error', (error) => {
        const status = error instanceof HttpError ? error.status : 502;
        if (res.headersSent || res.destroyed) {
          res.destroy();
          finish(null, 'upstream_error');
          return;
        }
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: status === 504 ? 'fault_proxy_upstream_timeout' : 'fault_proxy_upstream', message: error.message }));
        finish(status, 'upstream_error');
      });
      upstreamReq.end(body);
    };

    const pipeThrough = () =>
      forward((upstreamRes) => {
        const headers = { ...upstreamRes.headers };
        for (const name of Object.keys(headers)) if (HOP_BY_HOP.has(name)) delete headers[name];
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => finish(upstreamRes.statusCode ?? null, rule ? 'forwarded_after_rule' : 'forwarded'));
      });

    if (!rule) {
      pipeThrough();
      return;
    }

    if (rule.action === 'fail') {
      if (rule.drop) {
        finish(null, 'dropped');
        req.socket.destroy();
        return;
      }
      answerWith(rule.status, rule.body);
      return;
    }

    if (rule.action === 'delay') {
      const timer = setTimeout(() => {
        timers.delete(timer);
        cleanups.delete(cancel);
        pipeThrough();
      }, rule.ms);
      const cancel = () => {
        clearTimeout(timer);
        timers.delete(timer);
      };
      timers.add(timer);
      cleanups.add(cancel);
      return;
    }

    // hold: with a status the request never reaches the target and that status
    // is the answer on release; without one the real answer is fetched now and
    // delivered on release.
    const holdId = `h${entry.seq}`;
    entry.outcome = 'held';
    const record = { id: holdId, ruleId: rule.id, method, path: entry.path, since: entry.time, release: null };
    held.set(holdId, record);
    cleanups.add(() => held.delete(holdId));
    if (rule.status !== null) {
      record.release = () => answerWith(rule.status, rule.body);
      return;
    }
    let ready = null;
    let wanted = false;
    const deliver = () => {
      if (res.destroyed) return;
      res.writeHead(ready.status, ready.headers);
      res.end(ready.body);
      finish(ready.status, 'released');
    };
    record.release = () => {
      wanted = true;
      if (ready) deliver();
    };
    forward((upstreamRes) => {
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const headers = { ...upstreamRes.headers };
        for (const name of Object.keys(headers)) if (HOP_BY_HOP.has(name)) delete headers[name];
        headers['content-length'] = String(Buffer.concat(chunks).length);
        ready = { status: upstreamRes.statusCode ?? 502, headers, body: Buffer.concat(chunks) };
        if (wanted) deliver();
      });
    });
  }));

  const controlServer = http.createServer(guarded(async (req, res) => {
    // A browser page cannot drive this: loopback Host (no DNS rebinding), no
    // Origin header, a JSON content type on writes, and the per-run token.
    const url = parseTarget(req.url);
    const hostHeader = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(hostHeader)) throw new HttpError(403, 'control API answers loopback Host headers only');
    if (req.headers.origin !== undefined) throw new HttpError(403, 'control API refuses requests with an Origin header');
    const given = Buffer.from(String(req.headers['x-qa-token'] ?? ''));
    if (given.length !== controlTokenBuffer.length || !timingSafeEqual(given, controlTokenBuffer)) {
      throw new HttpError(401, 'X-QA-Token missing or wrong');
    }
    const method = req.method ?? 'GET';
    if (method !== 'GET' && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      throw new HttpError(415, 'control writes need content-type: application/json');
    }
    let input = {};
    try {
      const raw = await readBody(req, MAX_CONTROL_BODY_BYTES);
      input = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    } catch (error) {
      throw error instanceof HttpError ? error : new HttpError(400, 'body must be JSON');
    }
    const ruleMatch = /^\/rules\/([^/]+)$/.exec(url.pathname);

    if (url.pathname === '/rules' && method === 'GET') return sendJson(res, 200, { rules: rules.map(publicRule) });
    if (url.pathname === '/rules' && method === 'POST') {
      if (rules.length >= MAX_RULES) throw new HttpError(400, `at most ${MAX_RULES} rules; clear some first`);
      let rule;
      try {
        rule = normalizeRule(input);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      rules.push(rule);
      return sendJson(res, 201, { rule: publicRule(rule) });
    }
    if (url.pathname === '/rules' && method === 'DELETE') {
      const cleared = rules.length;
      rules.length = 0;
      return sendJson(res, 200, { cleared });
    }
    if (ruleMatch && method === 'DELETE') {
      const index = rules.findIndex((rule) => rule.id === ruleMatch[1]);
      if (index === -1) return sendJson(res, 404, { error: 'no such rule' });
      rules.splice(index, 1);
      return sendJson(res, 200, { removed: ruleMatch[1] });
    }
    if (url.pathname === '/held' && method === 'GET') {
      return sendJson(res, 200, { held: [...held.values()].map(({ release, ...rest }) => rest) });
    }
    if (url.pathname === '/release' && method === 'POST') {
      const chosen = [...held.values()].filter(
        (item) => (input.ruleId === undefined || item.ruleId === input.ruleId) && (input.id === undefined || item.id === input.id),
      );
      for (const item of chosen) {
        held.delete(item.id);
        item.release();
      }
      return sendJson(res, 200, { released: chosen.length });
    }
    if (url.pathname === '/log' && method === 'GET') return sendJson(res, 200, { entries: log });
    if (url.pathname === '/log' && method === 'DELETE') {
      const cleared = log.length;
      log.length = 0;
      return sendJson(res, 200, { cleared });
    }
    if (url.pathname === '/bodies' && method === 'GET') return sendJson(res, 200, { enabled: bodiesEnabled, dir: bodyDir });
    if (url.pathname === '/bodies' && method === 'POST') {
      bodiesEnabled = input.enabled === true;
      if (bodiesEnabled) ensureBodyDir();
      return sendJson(res, 200, { enabled: bodiesEnabled, dir: bodyDir });
    }
    return sendJson(res, 404, { error: 'unknown control route' });
  }));

  answerClientErrors(proxyServer);
  answerClientErrors(controlServer);

  let proxyAddress;
  let controlAddress;
  try {
    proxyAddress = await listenOn(proxyServer, options.port ?? 8787);
    controlAddress = await listenOn(controlServer, options.controlPort ?? 8788);
  } catch (error) {
    proxyServer.close();
    controlServer.close();
    throw error;
  }

  const tokenFile = controlTokenPath(controlAddress.port);
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, `${controlToken}\n`, { mode: 0o600 });

  const close = async () => {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const item of held.values()) item.release = () => {};
    held.clear();
    rmSync(tokenFile, { force: true });
    await Promise.all(
      [proxyServer, controlServer].map(
        (server) =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      ),
    );
  };

  return {
    host: HOST,
    port: proxyAddress.port,
    controlPort: controlAddress.port,
    controlToken,
    controlTokenFile: tokenFile,
    addresses: { proxy: proxyAddress.address, control: controlAddress.address },
    target: `${target.origin}${basePath}`,
    bodyDir: () => bodyDir,
    close,
  };
}

function parseCliArgs(argv) {
  const out = { port: 8787, controlPort: 8788, logBodies: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--target') out.target = value();
    else if (arg === '--port') out.port = Number(value());
    else if (arg === '--control-port') out.controlPort = Number(value());
    else if (arg === '--body-dir') out.bodyDir = value();
    else if (arg === '--log-bodies') out.logBodies = true;
    else if (arg === '--upstream-timeout-ms') out.upstreamTimeoutMs = Number(value());
    else throw new Error(`unknown option ${arg}`);
  }
  if (!out.target) throw new Error('--target is required');
  return out;
}

async function main() {
  let proxy;
  try {
    proxy = await startFaultProxy(parseCliArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`fault proxy: ${error.message}\n`);
    process.exit(1);
  }
  process.stdout.write(
    [
      `fault proxy (local QA tool) → ${proxy.target}`,
      `  app base URL : http://localhost:${proxy.port}`,
      `  control API  : http://127.0.0.1:${proxy.controlPort}  (node scripts/qa/faultProxyCtl.mjs --control-port ${proxy.controlPort} …)`,
      `  X-QA-Token   : ${proxy.controlToken}  (also in ${proxy.controlTokenFile}, mode 0600)`,
      `  bodies       : ${proxy.bodyDir() ?? 'off (POST /bodies {"enabled":true})'}`,
      '  stop with Ctrl-C',
      '',
    ].join('\n'),
  );
  const stop = async () => {
    await proxy.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
