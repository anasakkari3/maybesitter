/**
 * There is one route to Gemini, and it asks first (UC-2.1, #161).
 *
 * The capture path checks consent before requesting a model. That is one check
 * in one place, and the features that will want a model next — profile
 * extraction (#168), importance estimation (#169) — have not been written.
 * Whoever writes them will reach for a provider, and the test below is what
 * decides which provider they can reach.
 *
 * It is a static check on imports rather than a behavioural one because the
 * failure it prevents is a *future* omission: a new module that calls Gemini
 * directly would pass every behavioural test in this repository, because none
 * of them would know to look at it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planExternalActionGateway } from '../../lib/actions/externalActionGateway.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every TypeScript source file in the backend, tests excluded. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

const BACKEND = ['lib', 'src', 'scripts'].flatMap((top) => sourceFiles(join(repoRoot, top)));

function importers(pattern: RegExp): string[] {
  return BACKEND
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(repoRoot, file))
    .sort();
}

test('only the provider selector builds a Gemini client', () => {
  // `createGeminiProvider` reaches Vertex with no consent check of its own.
  // The selector is allowed to construct it; nothing else is, so there is no
  // ungated provider lying around for a future caller to pick up.
  assert.deepEqual(
    importers(/createGeminiProvider|from '\.\/geminiProvider'|geminiProvider'/),
    ['src/extraction/llm/geminiProvider.ts', 'src/extraction/llm/index.ts'],
    'something outside the provider selector builds a Gemini client',
  );
});

test('only the consent gate takes the configured provider', () => {
  // `getDefaultProvider()` returns whatever is configured — possibly Gemini —
  // with no consent attached. Exactly one module may call it, and that module
  // is the one that asks.
  const callers = importers(/getDefaultProvider\s*\(/).filter((file) => file !== 'src/extraction/llm/index.ts');
  assert.deepEqual(
    callers,
    ['lib/llm/consentGatedProvider.ts'],
    'a module other than the consent gate takes the configured provider',
  );
});

test('the capture path reaches the model through the gate', () => {
  // The positive half: the gate is not merely the only *allowed* route, it is
  // the route actually taken. Without this the two tests above would pass on a
  // system where nothing called the model at all.
  const captureProvider = readFileSync(join(repoRoot, 'lib/llm/captureProvider.ts'), 'utf8');
  assert.match(captureProvider, /consentGatedProvider\(uid/, 'the capture path does not use the gated provider');
  assert.doesNotMatch(captureProvider, /getDefaultProvider/, 'the capture path takes the provider directly');
});

test('no backend module imports the Google Gen AI SDK except the provider', () => {
  // The SDK is the other way to reach Vertex: importing it directly would skip
  // the provider, the gate, the cost guard and the logging in one step.
  assert.deepEqual(
    // Static, dynamic and require forms: the provider uses `await import`, and
    // a pattern that missed that would be a boundary test that passes because
    // it is looking for the wrong spelling.
    importers(/['"]@google\/genai['"]/),
    ['src/extraction/llm/geminiProvider.ts'],
    'a module outside the provider imports the Gen AI SDK',
  );
});

test('external action gateway plans controlled email and MCP actions through policy', () => {
  const sendEmail = planExternalActionGateway({
    actionId: 'action-email-1',
    idempotencyKey: 'idem-email-1',
    capability: 'send_email',
    provider: 'google',
    actor: 'model',
    userConfirmed: false,
    strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: true,
  });
  assert.equal(sendEmail.route, 'confirmation');
  assert.equal(sendEmail.providerExecutionAllowed, false);
  assert.equal(sendEmail.modelMaySelectRawProviderTool, false);

  const confirmedDraft = planExternalActionGateway({
    actionId: 'action-email-2',
    idempotencyKey: 'idem-email-2',
    capability: 'draft_email',
    provider: 'microsoft',
    actor: 'model',
    userConfirmed: true,
    strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: false,
  });
  assert.equal(confirmedDraft.route, 'external_action');
  assert.equal(confirmedDraft.providerExecutionAllowed, true);

  const mcpLookup = planExternalActionGateway({
    actionId: 'action-mcp-1',
    idempotencyKey: null,
    capability: 'mcp_lookup_context',
    provider: 'mcp',
    actor: 'system',
    userConfirmed: false,
    strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: false,
  });
  assert.equal(mcpLookup.route, 'read_context');
  assert.equal(mcpLookup.providerExecutionAllowed, true);

  const rawProviderTool = planExternalActionGateway({
    actionId: 'action-raw-1',
    idempotencyKey: null,
    capability: 'gmail.users.messages.send',
    provider: 'google',
    actor: 'model',
    userConfirmed: true,
    strongConfirmation: true,
    settingsAllowAutomaticExternalWrites: true,
  });
  assert.equal(rawProviderTool.route, 'blocked');
  assert.equal(rawProviderTool.policyDecision.reason, 'raw_provider_tool_denied');
  assert.equal(rawProviderTool.providerExecutionAllowed, false);
});
