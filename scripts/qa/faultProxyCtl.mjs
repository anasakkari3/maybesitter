#!/usr/bin/env node
// Command line for the QA fault proxy's control API (scripts/qa/faultProxy.mjs).
// A LOCAL DEVELOPMENT TOOL, not product code. It only ever talks to 127.0.0.1.
//
//   node scripts/qa/faultProxyCtl.mjs [--control-port 8788] <command> …
//
//   fail  <METHOD|*> <pathRegex> [--status N] [--body '<json>'] [--drop] [--once|--times N]
//   delay <METHOD|*> <pathRegex> <ms>                                  [--once|--times N]
//   hold  <METHOD|*> <pathRegex> [--status N] [--body '<json>']        [--once|--times N]
//   rules | clear | remove <ruleId>
//   held  | release [ruleId]
//   log   | log-clear
//   bodies on|off
//
// METHOD is a plain method (GET) or `*`; it becomes an anchored expression.
// pathRegex is matched against the path without its query string.
//
// The control token is read from the 0600 file the proxy wrote for that
// control port (see `controlTokenPath` in faultProxy.mjs).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { controlTokenPath } from './faultProxy.mjs';

const RULE_COMMANDS = new Set(['fail', 'delay', 'hold']);
const OTHER_COMMANDS = new Set(['rules', 'clear', 'remove', 'held', 'release', 'log', 'log-clear', 'bodies']);

function methodExpression(raw) {
  if (raw === undefined) throw new Error('a rule needs a METHOD (or *) and a path expression');
  if (raw === '*') return '.*';
  if (/^[A-Za-z]+$/.test(raw)) return `^${raw.toUpperCase()}$`;
  return raw;
}

/** Turns command-line arguments into a control request. Exported for tests. */
export function parseCtlArgs(argv) {
  const args = [...argv];
  let controlPort = 8788;
  const portAt = args.indexOf('--control-port');
  if (portAt !== -1) {
    controlPort = Number(args[portAt + 1]);
    if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) throw new Error('--control-port needs a port');
    args.splice(portAt, 2);
  }
  const command = args.shift();
  if (command === undefined || (!RULE_COMMANDS.has(command) && !OTHER_COMMANDS.has(command))) {
    throw new Error(`unknown command ${JSON.stringify(command)}`);
  }
  if (!RULE_COMMANDS.has(command)) {
    return { command, controlPort, args };
  }

  const positional = [];
  const rule = { action: command };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = () => {
      const next = args[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--status') rule.status = Number(value());
    else if (arg === '--body') rule.body = value();
    else if (arg === '--drop') rule.drop = true;
    else if (arg === '--once') rule.once = true;
    else if (arg === '--times') rule.times = Number(value());
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  const [method, path, ms] = positional;
  if (path === undefined) throw new Error('a rule needs a METHOD (or *) and a path expression');
  const ordered = { action: command, method: methodExpression(method), path };
  if (command === 'delay') {
    if (ms === undefined) throw new Error('delay needs milliseconds');
    ordered.ms = Number(ms);
  }
  for (const key of ['status', 'body', 'drop', 'once', 'times']) {
    if (rule[key] !== undefined) ordered[key] = rule[key];
  }
  return { command, controlPort, rule: ordered };
}

/** The token the proxy on `controlPort` wrote at start-up. */
export function readControlToken(controlPort) {
  try {
    return readFileSync(controlTokenPath(controlPort), 'utf8').trim();
  } catch {
    throw new Error(`no control token for port ${controlPort} (${controlTokenPath(controlPort)}); is the proxy running?`);
  }
}

function call(controlPort, method, path, body) {
  return new Promise((done, fail) => {
    const payload = JSON.stringify(body ?? {});
    const token = readControlToken(controlPort);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: controlPort,
        method,
        path,
        headers: method === 'GET'
          ? { 'x-qa-token': token }
          : { 'x-qa-token': token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', fail);
    req.end(method === 'GET' ? undefined : payload);
  });
}

function requestFor(parsed) {
  if (parsed.rule) return ['POST', '/rules', parsed.rule];
  const [first] = parsed.args;
  switch (parsed.command) {
    case 'rules': return ['GET', '/rules'];
    case 'clear': return ['DELETE', '/rules'];
    case 'remove':
      if (!first) throw new Error('remove needs a rule id');
      return ['DELETE', `/rules/${encodeURIComponent(first)}`];
    case 'held': return ['GET', '/held'];
    case 'release': return ['POST', '/release', first ? { ruleId: first } : {}];
    case 'log': return ['GET', '/log'];
    case 'log-clear': return ['DELETE', '/log'];
    case 'bodies':
      if (first !== 'on' && first !== 'off') throw new Error('bodies takes on or off');
      return ['POST', '/bodies', { enabled: first === 'on' }];
    default: throw new Error(`unknown command ${parsed.command}`);
  }
}

async function main() {
  try {
    const parsed = parseCtlArgs(process.argv.slice(2));
    const [method, path, body] = requestFor(parsed);
    const reply = await call(parsed.controlPort, method, path, body);
    process.stdout.write(`${reply.text}\n`);
    process.exit(reply.status >= 400 ? 1 : 0);
  } catch (error) {
    process.stderr.write(`fault proxy ctl: ${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
