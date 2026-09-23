/**
 * Nothing raw reaches a log line or an analytics event.
 *
 * A response body is the leak everybody thinks of. The one that actually
 * happens is a log: somebody adds `console.error('...', error)` while
 * debugging, an upstream failure quotes the row it choked on, and a year of
 * somebody's spending is sitting in a log sink that a different set of people
 * can read.
 *
 * This runs the whole path — success and failure — with every console method
 * captured, and asserts none of the fixture's raw strings reached any of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as contextGet } from '../../src/app/api/mobile/financial/context/route.ts';
import { GET as manualGet, PUT as manualPut } from '../../src/app/api/mobile/financial/manual/route.ts';
import { POST as connectionPost } from '../../src/app/api/mobile/financial/connection/route.ts';
import { assertNoSentinel } from './financialSentinels.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('FinancialLogUser');
const ROOT = process.cwd();
const ok = (condition: boolean, message: string) => assert.ok(condition, message);

type Captured = { readonly lines: string[]; restore(): void };

/** Every console method, not just `error`: a stray `console.log` leaks the same bytes. */
function captureConsole(): Captured {
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const originals = methods.map((method) => [method, console[method]] as const);
  for (const method of methods) {
    console[method] = ((...args: unknown[]) => {
      lines.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}\n${arg.stack ?? ''}` : String(arg))).join(' '));
    }) as typeof console.log;
  }
  return {
    lines,
    restore() {
      for (const [method, original] of originals) console[method] = original;
    },
  };
}

let auth: FakeAuthControls | null = null;

function setup(storage?: StorageAdapter): () => void {
  setStorageForTests(storage ?? createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}/api/mobile/financial/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${tokenFor(USER)}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  });
}

test('a whole successful read writes nothing raw to any console method', async () => {
  const teardown = setup();
  const captured = captureConsole();
  try {
    await connectionPost(request('connection', { method: 'POST' }));
    await manualPut(request('manual', {
      method: 'PUT',
      body: JSON.stringify({ field: 'savings_goal', kind: 'statement', value: 1_500_000 }),
    }));
    await contextGet(request('context'));
    await manualGet(request('manual'));
  } finally {
    captured.restore();
    teardown();
  }
  assertNoSentinel(captured.lines.join('\n'), ok, 'a log line');
});

test('an upstream error that quotes the payload is not logged verbatim', async () => {
  const base = createMemoryStorage() as unknown as StorageAdapter;
  const exploding: StorageAdapter = Object.assign(Object.create(base) as StorageAdapter, {
    list: async () => {
      throw new Error('FAILED_PRECONDITION reading MCDONALDS ZEBRAHOUSE sbx-txn-0004 ****4432');
    },
  });
  const teardown = setup(exploding);
  const captured = captureConsole();
  try {
    await contextGet(request('context'));
    await manualGet(request('manual'));
  } finally {
    captured.restore();
    teardown();
  }
  assert.ok(captured.lines.length > 0, 'the failure was not logged at all, so this proved nothing');
  assert.ok(captured.lines.join('\n').includes('[financial]'), 'the financial failure was not the thing logged');
  assertNoSentinel(captured.lines.join('\n'), ok, 'a failure log line');
});

/* ── And the structural half ──────────────────────────────────────── */

function financialSources(): Array<{ file: string; text: string }> {
  const found: Array<{ file: string; text: string }> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.ts')) found.push({ file: path.slice(ROOT.length + 1), text: readFileSync(path, 'utf8') });
    }
  };
  walk(join(ROOT, 'lib', 'services', 'financial'));
  walk(join(ROOT, 'lib', 'integrations', 'financial'));
  walk(join(ROOT, 'src', 'app', 'api', 'mobile', 'financial'));
  return found;
}

test('no financial module logs an error object, and none of them reaches analytics', () => {
  for (const { file, text } of financialSources()) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /*
     * Line by line, and matching only a bare `error` as the final argument.
     * A pattern over the whole call caught `storageFailureCause(error)` too,
     * which is the fix rather than the defect — a guard that fires on its own
     * remedy teaches people to weaken the guard.
     */
    for (const line of code.split('\n')) {
      if (!line.includes('console.')) continue;
      assert.ok(
        !/,\s*error\s*\)/.test(line),
        `${file} logs the error object itself; log storageFailureCause(error) instead`,
      );
    }
    for (const specifier of Array.from(code.matchAll(/from\s+'([^']+)'/g), (m) => m[1]!)) {
      assert.ok(
        !/analytics|telemetry|alphaTrace|auditEvent/i.test(specifier),
        `${file} imports ${specifier}: financial data has no business in an event stream`,
      );
    }
  }
});
