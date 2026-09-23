/**
 * The four things the financial feature must not be able to do, checked where
 * they are actually true or false.
 *
 *  1. Reach the planner, the scheduler, or a commitment writer.
 *  2. Be reached by the planner, the model layer, or coaching.
 *  3. Carry a transaction row upward out of the normalizer.
 *  4. Have a payment verb anywhere on the seam.
 *
 * ── Why these are asserted against the source text ───────────────
 *
 * "The planner cannot see this" is a claim about the import graph, and a
 * behavioural test can only sample it: a branch nobody exercised that imported
 * the financial service would pass every other test in this directory. So the
 * reachability claims are checked in what the modules import, which is where
 * they are decided.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  FINANCIAL_BOUNDARY_POLICY,
  FINANCIAL_SOURCE_KINDS,
} from '../../src/contracts/v1/financialContracts.ts';
import { FINANCIAL_PORT_POLICY } from '../../lib/integrations/financial/port.ts';
import { SANDBOX_FINANCIAL_TRANSPORT_POLICY } from '../../lib/integrations/financial/sandbox/sandboxTransport.ts';
import { providerCatalogEntry } from '../../lib/integrations/providers/providerCatalog.ts';
import { policyForCapability } from '../../src/contracts/v1/actionPolicyContracts.ts';

const ROOT = process.cwd();

/** The directories the financial feature lives in. */
const FINANCIAL_DIRS = ['lib/services/financial', 'lib/integrations/financial'];

/** The directories that must never learn the word. */
const FORBIDDEN_CONSUMERS = ['lib/planning', 'lib/llm', 'lib/coaching'];

function sourcesUnder(relative: string): Array<{ file: string; text: string }> {
  const base = join(ROOT, relative);
  const found: Array<{ file: string; text: string }> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.ts')) found.push({ file: path.slice(ROOT.length + 1), text: code(readFileSync(path, 'utf8')) });
    }
  };
  walk(base);
  return found;
}

/**
 * The code, with the prose taken out.
 *
 * Without this the first thing these guards catch is their own subject's
 * documentation: `port.ts` says in its header that there is no
 * `initiatePayment`, and a scan that reads comments treats saying so as doing
 * it. Stripping comments also keeps a worked example in a doc comment from
 * looking like a real import.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function importSpecifiers(text: string): string[] {
  return Array.from(text.matchAll(/(?:from|import)\s+'([^']+)'/g), (match) => match[1]!);
}

/* ── 1. The feature cannot reach the planner ──────────────────────── */

test('no financial module imports the planner, the scheduler or a commitment writer', () => {
  const forbidden = /(planning|scheduler|recommendation|coaching|commandService|stateMachine|dailyPlan|llm)/i;
  for (const { file, text } of FINANCIAL_DIRS.flatMap(sourcesUnder)) {
    for (const specifier of importSpecifiers(text)) {
      assert.ok(
        !forbidden.test(specifier),
        `${file} imports ${specifier}: the financial feature reached into planning`,
      );
    }
  }
});

/* ── 2. The planner cannot reach the feature ──────────────────────── */

test('no planner, model or coaching module imports anything financial', () => {
  for (const { file, text } of FORBIDDEN_CONSUMERS.flatMap(sourcesUnder)) {
    for (const specifier of importSpecifiers(text)) {
      assert.ok(
        !/financial/i.test(specifier),
        `${file} imports ${specifier}: financial context reached a consumer v1 says it must not`,
      );
    }
  }
});

/* ── 3. No transaction can travel upward ──────────────────────────── */

test('nothing the normalizer exports has a place to put a transaction row', () => {
  const text = readFileSync(join(ROOT, 'lib', 'integrations', 'financial', 'adapter.ts'), 'utf8');
  const exported = text.slice(text.indexOf('export interface NormalizedFinancialObservations'));
  const surface = exported.slice(0, exported.indexOf('\n}'));
  for (const forbidden of ['Transaction', 'merchant', 'description', 'accountId', 'accountNumber']) {
    assert.ok(
      !surface.includes(forbidden),
      `the normalizer's return type carries "${forbidden}"`,
    );
  }
});

test('the financial state contract has no transaction field at all', () => {
  const text = readFileSync(join(ROOT, 'src', 'contracts', 'v1', 'financialContracts.ts'), 'utf8');
  const state = text.slice(text.indexOf('export interface FinancialState'));
  const body = state.slice(0, state.indexOf('\n}'));
  assert.ok(!/transaction/i.test(body), 'FinancialState grew a transaction field');
  assert.ok(!/merchant/i.test(body), 'FinancialState grew a merchant field');
});

/* ── 4. No payment verb exists ────────────────────────────────────── */

test('the port has read verbs and no way to move money', () => {
  const text = code(readFileSync(join(ROOT, 'lib', 'integrations', 'financial', 'port.ts'), 'utf8'));
  const iface = text.slice(text.indexOf('export interface FinancialDataPort'));
  const body = iface.slice(0, iface.indexOf('\n}'));
  const verbs = Array.from(body.matchAll(/^\s{2}(\w+)\(/gm), (match) => match[1]!);
  assert.deepEqual(verbs.sort(), ['listAccounts', 'listBalances', 'listRecurring', 'listTransactions']);
});

test('no financial module names a payment, a transfer or a payee', () => {
  const forbidden = /\b(initiatePayment|createPayment|transferFunds|createRecipient|createPayee|initiateTransfer)\b/;
  for (const { file, text } of FINANCIAL_DIRS.flatMap(sourcesUnder)) {
    assert.ok(!forbidden.test(text), `${file} names a way to move money`);
  }
});

test('the financial provider surface grants exactly one action capability, and it is a read', () => {
  const entry = providerCatalogEntry('financial_sandbox');
  assert.deepEqual([...entry.actionCapabilities], ['read_financial_context']);
  assert.deepEqual([...entry.connectionCapabilities], ['financial_read']);
  assert.equal(entry.rawProviderToolsAllowedForModel, false);
  // The id exists so the read is declared in the closed capability table
  // (ADR-0002 §9). What keeps money unmovable is the tier: every capability
  // this surface names must be a read, and the only money-moving id in the
  // table stays `unsupported`.
  for (const capability of entry.actionCapabilities) {
    assert.equal(policyForCapability(capability)?.tier, 'read_only_context', `${capability} is not a read`);
  }
  assert.equal(policyForCapability('spend_money')?.tier, 'unsupported');
  assert.equal(policyForCapability('spend_money')?.providerExecutionAllowed, false);
});

/* ── The declared policies say what the code does ─────────────────── */

test('every boundary flag is false, and stays that way', () => {
  for (const [flag, value] of Object.entries(FINANCIAL_BOUNDARY_POLICY)) {
    assert.equal(value, false, `${flag} turned true without the rest of the feature changing with it`);
  }
});

test('the port and the sandbox describe themselves honestly', () => {
  assert.equal(FINANCIAL_PORT_POLICY.readOnly, true);
  assert.equal(FINANCIAL_PORT_POLICY.paymentVerbs, 0);
  assert.equal(FINANCIAL_PORT_POLICY.genericPassthroughVerb, false);
  assert.equal(SANDBOX_FINANCIAL_TRANSPORT_POLICY.readsNetwork, false);
  assert.equal(SANDBOX_FINANCIAL_TRANSPORT_POLICY.isProductionDataSource, false);
});

test('there are two sources and the state knows both by name', () => {
  assert.deepEqual([...FINANCIAL_SOURCE_KINDS].sort(), ['manual', 'provider']);
});

/* ── The AI consent claim is untouched ────────────────────────────── */

test('no financial module reaches the consent layer, so the shipped AI claim is still literally true', () => {
  for (const { file, text } of FINANCIAL_DIRS.flatMap(sourcesUnder)) {
    for (const specifier of importSpecifiers(text)) {
      assert.ok(
        !/consent/i.test(specifier),
        `${file} imports ${specifier}: v1 sends nothing to a model and should need no AI consent`,
      );
    }
  }
});
