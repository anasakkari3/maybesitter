/**
 * The two routes an imported AI profile travels over.
 *
 * ── What these are guarding ──────────────────────────────────────
 *
 *  1. The paste is never stored — it is the largest single piece of text about
 *     a person this product accepts, and it is somebody else's model's prose
 *     about them. A sentinel is searched for across everything written.
 *  2. Nothing reaches memory until the user keeps a row.
 *  3. With AI consent declined the endpoint refuses with a reason the client can
 *     act on, and makes zero model calls.
 *  4. A proposal id is the only thing the confirm route is handed, so the
 *     cross-account case is the one that matters: guessing another user's id
 *     must write nothing into either account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests, getStorage } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { setAiConsent } from '../../lib/consents/aiConsentService.ts';
import { AI_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { MAX_IMPORTS_PER_DAY, MAX_IMPORT_LENGTH } from '../../src/profile/aiContextImportContracts.ts';
import { confirmAiContextImport, importAiContext } from '../../lib/services/mobile/aiContextImportService.ts';
import { POST as importPost } from '../../src/app/api/mobile/profile/import/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/profile/import/confirm/route.ts';

const BASE = 'http://127.0.0.1:4321';
const UID = uidFor('ImportUser');
const OTHER = uidFor('ImportIntruder');
const AT = new Date('2026-09-23T09:00:00.000Z');
const SENTINEL = 'ZZQXIMPORTSENTINELQZZ';

let auth: FakeAuthControls | null = null;
let previousFlag: string | undefined;

function begin(flag = 'true'): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  previousFlag = process.env.MAYBESITTER_FEATURE_MEMORY;
  process.env.MAYBESITTER_FEATURE_MEMORY = flag;
}

function end(): void {
  if (previousFlag === undefined) delete process.env.MAYBESITTER_FEATURE_MEMORY;
  else process.env.MAYBESITTER_FEATURE_MEMORY = previousFlag;
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function request(path: string, body: unknown, uid: string | null = UID): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (uid) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

async function grant(uid = UID): Promise<void> {
  await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });
}

/** Everything written under this user, as one string. */
async function everythingWritten(uid = UID): Promise<string> {
  const storage = getStorage();
  const names = ['aiContextImports', 'memory', 'auditEvents', 'profileProposals'];
  const rows = await Promise.all(names.map((name) => storage.list(`users/${uid}/${name}`)));
  const user = await storage.get(`users/${uid}`);
  return JSON.stringify({ rows, user });
}

/** A model that answers with one candidate and records the prompt it was sent. */
function stubModel() {
  const prompts: string[] = [];
  const generate = (async (req: { system: string; parts: readonly { text?: string }[] }) => {
    prompts.push(`${req.system}\n${req.parts.map((part) => part.text ?? '').join('')}`);
    return {
      text: JSON.stringify({ candidates: [{
        kind: 'fact', category: 'work_study', content: 'Is a nursing student',
        targetDate: null, confidence: 0.9, relation: 'new', relatesTo: null,
      }] }),
      model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 1, outputTokens: 1,
    };
  }) as never;
  return { prompts, generate };
}

test('an unauthenticated import is refused', async () => {
  begin();
  try {
    const response = await importPost(request('/api/mobile/profile/import', { text: 'x', assistant: 'chatgpt' }, null));
    assert.equal(response.status, 401);
  } finally { end(); }
});

test('the module kill switch closes both routes', async () => {
  begin('false');
  try {
    const first = await importPost(request('/api/mobile/profile/import', { text: 'x', assistant: 'chatgpt' }));
    const second = await confirmPost(request('/api/mobile/profile/import/confirm', { proposalId: 'p', accepted: [] }));
    assert.equal(first.status, 404);
    assert.equal(second.status, 404);
  } finally { end(); }
});

test('without AI consent the client is told why, not handed an empty list', async () => {
  begin();
  try {
    const response = await importPost(request('/api/mobile/profile/import', { text: 'a profile', assistant: 'chatgpt' }));
    assert.equal(response.status, 403);
    assert.equal((await json(response)).reason, 'consent_required');
  } finally { end(); }
});

test('an unknown assistant is refused', async () => {
  begin();
  await grant();
  try {
    const response = await importPost(request('/api/mobile/profile/import', { text: 'a profile', assistant: 'copilot' }));
    assert.equal(response.status, 400);
    assert.equal((await json(response)).reason, 'invalid_assistant');
  } finally { end(); }
});

test('an oversized paste is refused with the limit the client can show', async () => {
  begin();
  await grant();
  try {
    const response = await importPost(request('/api/mobile/profile/import', {
      text: 'x'.repeat(MAX_IMPORT_LENGTH + 1), assistant: 'chatgpt',
    }));
    // 413, as capture and share answer for the same thing, so the app's
    // existing mapping gives it a typed error carrying the number.
    assert.equal(response.status, 413);
    const body = await json(response);
    assert.equal(body.reason, 'import_too_long');
    assert.equal(body.maxCharacters, MAX_IMPORT_LENGTH);
  } finally { end(); }
});

test('a fourth import in one day is refused', async () => {
  begin();
  await grant();
  try {
    for (let i = 0; i < MAX_IMPORTS_PER_DAY; i += 1) {
      const ok = await importPost(request('/api/mobile/profile/import', { text: `profile ${i}`, assistant: 'chatgpt' }));
      assert.equal(ok.status, 200, `import ${i} was refused`);
    }
    const refused = await importPost(request('/api/mobile/profile/import', { text: 'again', assistant: 'chatgpt' }));
    assert.equal(refused.status, 429);
    const body = await json(refused);
    assert.equal(body.reason, 'import_rate_limited');
    assert.equal(body.maxPerDay, MAX_IMPORTS_PER_DAY);
  } finally { end(); }
});

test('the pasted profile is nowhere in the user tree', async () => {
  begin();
  await grant();
  try {
    const model = stubModel();
    const proposal = await importAiContext(UID, `They are a nursing student. ${SENTINEL}`, 'chatgpt', AT, {
      generate: model.generate,
    });

    // Swept while the proposal is still there. Confirm deletes it, so a sweep
    // that only runs afterwards cannot see a paste stored on the proposal at
    // all — which is how this assertion passed a mutation that stored one.
    const staged = await everythingWritten();
    assert.ok(!staged.includes(SENTINEL), 'the paste was stored on the proposal');

    await confirmAiContextImport(UID, proposal.proposalId, [{ index: 0 }], AT);

    const written = await everythingWritten();
    assert.ok(!written.includes(SENTINEL), 'the paste reached a memory record or the audit trail');
    // And it did reach the model, so this run actually exercised the path
    // rather than passing because nothing happened at all.
    assert.ok(model.prompts[0]?.includes(SENTINEL), 'the paste never reached the model');
  } finally { end(); }
});

test('importing alone writes no memory record', async () => {
  begin();
  await grant();
  try {
    await importPost(request('/api/mobile/profile/import', { text: 'a full profile', assistant: 'chatgpt' }));
    const memory = createStorageRuntimeMemoryStore();
    assert.equal((await memory.listAll(UID)).length, 0);
  } finally { end(); }
});

test('an unknown proposal id is a 404', async () => {
  begin();
  try {
    const response = await confirmPost(request('/api/mobile/profile/import/confirm', {
      proposalId: 'nope', accepted: [],
    }));
    assert.equal(response.status, 404);
    assert.equal((await json(response)).reason, 'proposal_not_found');
  } finally { end(); }
});

test('a missing proposalId is refused before the store is touched', async () => {
  begin();
  try {
    const response = await confirmPost(request('/api/mobile/profile/import/confirm', { accepted: [] }));
    assert.equal(response.status, 400);
  } finally { end(); }
});

test('another account cannot confirm this proposal', async () => {
  begin();
  await grant();
  await grant(OTHER);
  try {
    const generate = (async () => ({
      text: JSON.stringify({ candidates: [{
        kind: 'fact', category: 'work_study', content: 'Is a nursing student',
        targetDate: null, confidence: 0.9, relation: 'new', relatesTo: null,
      }] }),
      model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 1, outputTokens: 1,
    })) as never;
    const proposal = await importAiContext(UID, 'a profile', 'chatgpt', AT, { generate });

    const response = await confirmPost(request('/api/mobile/profile/import/confirm', {
      proposalId: proposal.proposalId, accepted: [{ index: 0 }],
    }, OTHER));
    assert.equal(response.status, 404);

    const memory = createStorageRuntimeMemoryStore();
    assert.equal((await memory.listAll(UID)).length, 0, 'the intruder wrote into the owner account');
    assert.equal((await memory.listAll(OTHER)).length, 0, 'the intruder wrote into their own account');
  } finally { end(); }
});

test('a confirm with a bad accepted list is refused', async () => {
  begin();
  try {
    const response = await confirmPost(request('/api/mobile/profile/import/confirm', {
      proposalId: 'p', accepted: 'all of them',
    }));
    assert.equal(response.status, 400);
  } finally { end(); }
});
