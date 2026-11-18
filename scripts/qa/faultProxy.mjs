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
//     Run service over https; anything else, production included, is refused;
//   - both servers bind 127.0.0.1 and nothing else;
//   - the Authorization header, cookies and token-shaped body fields are never
//     written to the log or a body file (they read «مخفي»);
//   - request bodies are written only when asked, to a temp directory outside
//     the repository.
//
// Only node:http and node:https; no dependency.
import http from 'node:http';
import https from 'node:https';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const REDACTED = 'مخفي';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// The staging Cloud Run service, optionally behind a revision tag (`tag---`).
// Only the first label decides; the domain must be Cloud Run's own.
const STAGING_HOST = /^(?:[a-z0-9-]+---)?maybesitter-api-staging-[a-z0-9-]+\.(?:[a-z0-9-]+\.)?run\.app$/;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_LOG = 2000;
const ACTIONS = new Set(['fail', 'delay', 'hold']);
const SECRET_HEADER = /authorization|cookie|token|secret|session|api-key|appcheck/i;
const SECRET_FIELD = /token|password|secret|authorization|cookie|credential|code_?verifier|^code$/i;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host',
]);

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
    `fault proxy refuses target ${url.origin}: only a local backend or the staging service (https://maybesitter-api-staging-…run.app). Production is never a target.`,
  );
}

function compile(source, field) {
  if (typeof source !== 'string' || source === '') throw new Error(`${field} must be a non-empty regular expression`);
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
    if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
      throw new Error('status must be an integer between 100 and 599');
    }
    rule.status = input.status;
  }
  if (input.body !== undefined) {
    if (typeof input.body !== 'string') throw new Error('body must be a string');
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
    out[name] = SECRET_HEADER.test(name) ? REDACTED : value;
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
      out[key] = SECRET_FIELD.test(key) ? REDACTED : redactValue(item, secrets);
    }
    return out;
  }
  return value;
}

function redactBody(buffer, secrets) {
  if (buffer.length === 0) return null;
  const text = buffer.toString('utf8');
  try {
    return redactValue(JSON.parse(text), secrets);
  } catch {
    let out = text;
    for (const secret of secrets) if (secret !== '') out = out.split(secret).join(REDACTED);
    return out;
  }
}

function insideRepo(dir) {
  const absolute = resolve(dir);
  return absolute === REPO_ROOT || absolute.startsWith(REPO_ROOT + sep);
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

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error('request body over 10 MB'));
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
  const text = JSON.stringify(value, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
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

  const rules = [];
  const held = new Map();
  const log = [];
  let seq = 0;
  let bodyDir = options.bodyDir === undefined ? null : resolve(options.bodyDir);
  let bodiesEnabled = options.logBodies === true;

  const ensureBodyDir = () => {
    if (bodyDir === null) bodyDir = mkdtempSync(join(tmpdir(), 'maybesitter-fault-proxy-'));
    mkdirSync(bodyDir, { recursive: true });
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
      body: redactBody(body, secrets),
    };
    writeFileSync(join(dir, name), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  };

  const proxyServer = http.createServer(async (req, res) => {
    const started = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    // Only the path and query of the request are used: an absolute-form URL
    // cannot point the proxy at another host.
    const local = new URL(req.url ?? '/', 'http://proxy.invalid');
    const pathWithQuery = `${local.pathname}${local.search}`;
    const entry = {
      seq: ++seq,
      time: new Date(started).toISOString(),
      method,
      path: pathWithQuery,
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
      entry.status = status;
      entry.outcome = outcome;
      entry.durationMs = Date.now() - started;
    };

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
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-fault-proxy': rule?.id ?? 'pass' });
      res.end(text ?? JSON.stringify({ error: 'fault_proxy', status }));
      finish(status, 'injected');
    };

    const forward = (onResponse) => {
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
          path: pathWithQuery,
          headers,
        },
        onResponse,
      );
      upstreamReq.on('error', (error) => {
        if (res.headersSent) {
          res.destroy();
          finish(null, 'upstream_error');
          return;
        }
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'fault_proxy_upstream', message: error.message }));
        finish(502, 'upstream_error');
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
      setTimeout(pipeThrough, rule.ms);
      return;
    }

    // hold: with a status the request never reaches the target and that status
    // is the answer on release; without one the real answer is fetched now and
    // delivered on release.
    const holdId = `h${entry.seq}`;
    entry.outcome = 'held';
    const record = { id: holdId, ruleId: rule.id, method, path: pathWithQuery, since: entry.time, release: null };
    held.set(holdId, record);
    res.on('close', () => held.delete(holdId));
    if (rule.status !== null) {
      record.release = () => answerWith(rule.status, rule.body);
      return;
    }
    let ready = null;
    let wanted = false;
    const deliver = () => {
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
  });

  const controlServer = http.createServer(async (req, res) => {
    // A browser page cannot reach this through DNS rebinding: the Host must be loopback.
    const hostHeader = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(hostHeader)) {
      sendJson(res, 403, { error: 'control API answers loopback Host headers only' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://control.invalid');
    const method = req.method ?? 'GET';
    let input = {};
    try {
      const raw = await readBody(req);
      input = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { error: 'body must be JSON' });
      return;
    }
    const ruleMatch = /^\/rules\/([^/]+)$/.exec(url.pathname);

    if (url.pathname === '/rules' && method === 'GET') return sendJson(res, 200, { rules: rules.map(publicRule) });
    if (url.pathname === '/rules' && method === 'POST') {
      try {
        const rule = normalizeRule(input);
        rules.push(rule);
        return sendJson(res, 201, { rule: publicRule(rule) });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
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
  });

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

  const close = async () => {
    for (const item of held.values()) item.release = () => {};
    held.clear();
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
    addresses: { proxy: proxyAddress.address, control: controlAddress.address },
    target: target.origin,
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
