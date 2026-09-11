import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as upcomingGet } from '../../src/app/api/mobile/commitments/upcoming/route.ts';
import {
  DELETE as commitmentDelete,
  GET as commitmentGet,
  PATCH as commitmentPatch,
} from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/commitments/[id]/actions/route.ts';
import { guardedMobileExtract } from '../../lib/services/mobile/safety.ts';
import { decideExtractionDisposition } from '../../src/extraction/extractionPolicy.ts';
import type { ExtractionResult } from '../../src/extraction/extractionTypes.ts';
import { configureCommandService, getCommandServiceState } from '../../lib/services/commandService.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';

const baseUrl = 'http://127.0.0.1:4321';
const referenceTime = '2026-08-09T08:00:00.000Z';

/**
 * These routes used to be reachable with no credential at all, and ran on one
 * process-global command service shared by every caller. Since UC-1.0e (#144)
 * every one of them requires a verified Firebase ID token and reads and
 * writes that uid's own tree, so this file authenticates as USER and asserts
 * persistence against that user's state rather than against a global.
 */
const USER = uidFor('RouteTestUser');

let auth: FakeAuthControls | null = null;

function request(path: string, body?: unknown): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(USER)}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The same request with no Authorization header. */
function anonymousRequest(path: string, body?: unknown): Request {
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** How many commitments this user actually has in storage. */
async function commitmentCount(uid = USER): Promise<number> {
  return Object.keys((await getParticipantStateSnapshot(uid)).commitments).length;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-mobile-api-'));
  configureCommandService({
    initialState: createEmptyDomainState(),
    schedulerStore: null,
  });
  const previousDataDir = process.env.MAYBESITTER_DATA_DIR;
  process.env.MAYBESITTER_DATA_DIR = dir;
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
    if (previousDataDir === undefined) delete process.env.MAYBESITTER_DATA_DIR;
    else process.env.MAYBESITTER_DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  };
}

async function createConfirmedCommitment(): Promise<{ itemId: string; commitmentId: string }> {
  const proposalResponse = await capturePost(request('/api/mobile/capture', {
    text: 'Call the dentist tomorrow at 3pm',
    referenceTime,
    timezone: 'UTC',
    scopeId: 'route-test',
  }));
  assert.equal(proposalResponse.status, 200);
  const proposal = await json(proposalResponse);
  assert.equal(proposal.status, 'proposed');
  assert.equal(await commitmentCount(), 0, 'a proposal must not persist anything');

  const items = proposal.items as Array<{ itemId: string }>;
  const itemId = items[0].itemId;
  const confirmResponse = await confirmPost(request('/api/mobile/capture/confirm', {
    proposalId: proposal.proposalId,
    scopeId: 'route-test',
    itemIds: [itemId],
  }));
  assert.equal(confirmResponse.status, 200);
  const confirmation = await json(confirmResponse);
  assert.equal(confirmation.success, true);
  const persisted = confirmation.persisted as Array<{ commitmentId: string }>;
  return { itemId, commitmentId: persisted[0].commitmentId };
}

function uncertainExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    type: 'task',
    action: 'Call the dentist',
    title: 'Call the dentist',
    person: null,
    dueAt: '2026-08-10T12:00:00.000Z',
    remindAt: '2026-08-10T12:00:00.000Z',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    confidence: { overall: 0.5, type: 0.8, action: 0.8, time: 0.8, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
    rawText: 'Call the dentist tomorrow at noon',
    parserVersion: 'test-v1',
    ...overrides,
  };
}

test('mobile API supports capture, confirm, list, detail, patch, action, and delete', async () => {
  const cleanup = setup();
  try {
    const { commitmentId } = await createConfirmedCommitment();

    const detailResponse = await commitmentGet(request(`/api/mobile/commitments/${commitmentId}`), params(commitmentId));
    assert.equal(detailResponse.status, 200);
    const before = await json(detailResponse);
    const beforeTimeSpec = before.timeSpec as Record<string, unknown>;

    const upcomingResponse = await upcomingGet(request(`/api/mobile/commitments/upcoming?referenceTime=${encodeURIComponent(referenceTime)}&timezone=UTC`));
    assert.equal(upcomingResponse.status, 200);
    const upcoming = await json(upcomingResponse);
    assert.equal((upcoming.items as unknown[]).length, 1);

    const patchTitleResponse = await commitmentPatch(
      new Request(`${baseUrl}/api/mobile/commitments/${commitmentId}`, {
        method: 'PATCH',
        headers: new Headers({ authorization: `Bearer ${tokenFor(USER)}`, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title: 'Call dentist urgent' }),
      }),
      params(commitmentId)
    );
    assert.equal(patchTitleResponse.status, 200);
    const afterTitle = await json(patchTitleResponse);
    assert.equal(afterTitle.title, 'Call dentist urgent');
    assert.deepEqual(afterTitle.timeSpec, beforeTimeSpec);

    const patchPriorityResponse = await commitmentPatch(
      new Request(`${baseUrl}/api/mobile/commitments/${commitmentId}`, {
        method: 'PATCH',
        headers: new Headers({ authorization: `Bearer ${tokenFor(USER)}`, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ priority: 'high' }),
      }),
      params(commitmentId)
    );
    assert.equal(patchPriorityResponse.status, 200);
    const afterPriority = await json(patchPriorityResponse);
    assert.deepEqual(afterPriority.timeSpec, beforeTimeSpec);

    const patchTimeResponse = await commitmentPatch(
      new Request(`${baseUrl}/api/mobile/commitments/${commitmentId}`, {
        method: 'PATCH',
        headers: new Headers({ authorization: `Bearer ${tokenFor(USER)}`, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ dueDate: '2026-08-12T16:00:00.000Z' }),
      }),
      params(commitmentId)
    );
    assert.equal(patchTimeResponse.status, 200);
    const afterTime = await json(patchTimeResponse);
    assert.notDeepEqual(afterTime.timeSpec, beforeTimeSpec);

    const completeResponse = await actionPost(
      request(`/api/mobile/commitments/${commitmentId}/actions`, { action: 'complete' }),
      params(commitmentId)
    );
    assert.equal(completeResponse.status, 200);
    const completed = await json(completeResponse);
    assert.equal((completed.commitment as Record<string, unknown>).status, 'completed');

    const deleteResponse = await commitmentDelete(request(`/api/mobile/commitments/${commitmentId}`), params(commitmentId));
    assert.equal(deleteResponse.status, 200);
    const deleted = await json(deleteResponse);
    assert.equal(deleted.success, true);
    assert.equal(deleted.softDeleted, true);

    const todayResponse = await todayGet(request('/api/mobile/commitments/today'));
    const today = await json(todayResponse);
    assert.equal((today.items as unknown[]).some((item) => (item as { id: string }).id === commitmentId), false);
  } finally {
    cleanup();
  }
});

test('mobile capture rejects malformed time and negated requests before persistence', async () => {
  const cleanup = setup();
  try {
    for (const text of [
      "Don't remind me to call Maya tomorrow at 3pm",
    ]) {
      const response = await capturePost(request('/api/mobile/capture', {
        text,
        referenceTime,
        timezone: 'UTC',
        scopeId: 'safety-test',
      }));
      assert.equal(response.status, 400);
      assert.equal(await commitmentCount(), 0);
    }

    const malformed = await capturePost(request('/api/mobile/capture', {
      text: 'Call Maya tomorrow at 3pm',
      referenceTime: 'not-a-time',
      timezone: 'UTC',
      scopeId: 'safety-test',
    }));
    assert.equal(malformed.status, 400);
    assert.equal(await commitmentCount(), 0);
  } finally {
    cleanup();
  }
});

test('mobile safety validation does not promote uncertain extraction semantics', async () => {
  const extraction = uncertainExtraction();
  const guarded = await guardedMobileExtract(
    extraction.rawText,
    { now: new Date(referenceTime), timezone: 'UTC' },
    {},
    async () => ({ result: extraction, engine: 'rule-based', fallbackReason: null })
  );

  assert.equal(guarded.result, extraction);
  assert.equal(guarded.result.explicitReminderRequest, false);
  assert.equal(guarded.result.confidence.overall, 0.5);
  assert.notEqual(decideExtractionDisposition(guarded.result), 'auto_confirm');
});

test('mobile safety validation rejects extracted past resolved times', async () => {
  const extraction = uncertainExtraction({
    dueAt: '2026-08-08T12:00:00.000Z',
    remindAt: '2026-08-08T12:00:00.000Z',
  });

  await assert.rejects(
    guardedMobileExtract(
      extraction.rawText,
      { now: new Date(referenceTime), timezone: 'UTC' },
      {},
      async () => ({ result: extraction, engine: 'rule-based', fallbackReason: null })
    ),
    /must not be in the past/
  );
});

test('mobile capture accepts future requests that mention earlier context', async () => {
  const cleanup = setup();
  try {
    for (const text of [
      'Remind me tomorrow to follow up on what we discussed earlier',
      'Tomorrow remind me to send the notes from earlier',
      'ذكرني بكرا أرسل الملاحظات من مبارح',
    ]) {
      const response = await capturePost(request('/api/mobile/capture', {
        text,
        referenceTime,
        timezone: 'UTC',
        scopeId: 'earlier-context',
      }));
      assert.equal(response.status, 200);
      const proposal = await json(response);
      assert.equal(proposal.status, 'proposed');
      assert.equal(await commitmentCount(), 0);
    }
  } finally {
    cleanup();
  }
});

test('mobile confirm enforces scope and selection before persistence', async () => {
  const cleanup = setup();
  try {
    const proposalResponse = await capturePost(request('/api/mobile/capture', {
      text: 'Call the dentist tomorrow at 3pm',
      referenceTime,
      timezone: 'UTC',
      scopeId: 'owner',
    }));
    const proposal = await json(proposalResponse);
    const items = proposal.items as Array<{ itemId: string }>;

    // The scope is the token's uid, so the confirm that must fail is another
    // *user's*, not another `scopeId` string — the body field is not read.
    // This used to be `scopeId: 'other'`, which a caller simply chose.
    const other = uidFor('SomebodyElse');
    const wrongScope = await confirmPost(new Request(`${baseUrl}/api/mobile/capture/confirm`, {
      method: 'POST',
      headers: new Headers({ authorization: `Bearer ${tokenFor(other)}`, 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        proposalId: proposal.proposalId,
        scopeId: 'owner',
        itemIds: [items[0].itemId],
      }),
    }));
    assert.equal(wrongScope.status, 200);
    assert.equal((await json(wrongScope)).success, false);
    assert.equal(await commitmentCount(), 0);
    assert.equal(await commitmentCount(other), 0);

    const emptySelection = await confirmPost(request('/api/mobile/capture/confirm', {
      proposalId: proposal.proposalId,
      scopeId: 'owner',
      itemIds: [],
    }));
    assert.equal(emptySelection.status, 400);
    assert.equal(await commitmentCount(), 0);
  } finally {
    cleanup();
  }
});

test('mobile confirm replays the same idempotency key without duplicating commitments', async () => {
  const cleanup = setup();
  try {
    const proposalResponse = await capturePost(request('/api/mobile/capture', {
      text: 'Remind me to call the dentist tomorrow at 3pm',
      referenceTime,
      timezone: 'UTC',
      scopeId: 'replay',
    }));
    const proposal = await json(proposalResponse);
    const itemId = (proposal.items as Array<{ itemId: string }>)[0].itemId;
    const payload = {
      proposalId: proposal.proposalId,
      scopeId: 'replay',
      itemIds: [itemId],
      idempotencyKey: 'same-key',
    };

    const first = await json(await confirmPost(request('/api/mobile/capture/confirm', payload)));
    const countAfterFirst = await commitmentCount();
    const second = await json(await confirmPost(request('/api/mobile/capture/confirm', payload)));

    assert.equal(first.success, true);
    assert.equal(first.replayed, false);
    assert.equal(second.success, true);
    assert.equal(second.replayed, true);
    assert.equal(await commitmentCount(), countAfterFirst);
    assert.equal(countAfterFirst, 1);
  } finally {
    cleanup();
  }
});

test('mobile confirm rejects idempotency mismatch without duplicating commitments', async () => {
  const cleanup = setup();
  try {
    const proposalResponse = await capturePost(request('/api/mobile/capture', {
      text: 'Remind me to call the dentist tomorrow at 3pm',
      referenceTime,
      timezone: 'UTC',
      scopeId: 'mismatch',
    }));
    const proposal = await json(proposalResponse);
    const itemId = (proposal.items as Array<{ itemId: string }>)[0].itemId;

    const first = await json(await confirmPost(request('/api/mobile/capture/confirm', {
      proposalId: proposal.proposalId,
      scopeId: 'mismatch',
      itemIds: [itemId],
      idempotencyKey: 'key-a',
    })));
    const stateAfterFirst = JSON.stringify((await getParticipantStateSnapshot(USER)).commitments);
    const second = await json(await confirmPost(request('/api/mobile/capture/confirm', {
      proposalId: proposal.proposalId,
      scopeId: 'mismatch',
      itemIds: [itemId],
      idempotencyKey: 'key-b',
    })));

    assert.equal(first.success, true);
    assert.equal(second.success, false);
    assert.deepEqual(second.failed, [{ itemId, reason: 'invalid_selection' }]);
    assert.equal(await commitmentCount(), 1);
    assert.equal(JSON.stringify((await getParticipantStateSnapshot(USER)).commitments), stateAfterFirst);
  } finally {
    cleanup();
  }
});

test('mobile today route includes a same-day future confirmed commitment', async () => {
  const cleanup = setup();
  try {
    const proposalResponse = await capturePost(request('/api/mobile/capture', {
      text: 'Remind me to call Maya at 11am',
      referenceTime,
      timezone: 'UTC',
      scopeId: 'same-day',
    }));
    const proposal = await json(proposalResponse);
    const itemId = (proposal.items as Array<{ itemId: string }>)[0].itemId;
    const confirmation = await json(await confirmPost(request('/api/mobile/capture/confirm', {
      proposalId: proposal.proposalId,
      scopeId: 'same-day',
      itemIds: [itemId],
      idempotencyKey: 'same-day-key',
    })));
    const commitmentId = ((confirmation.persisted as Array<{ commitmentId: string }>)[0]).commitmentId;

    const today = await json(await todayGet(request('/api/mobile/commitments/today?timezone=UTC&referenceTime=2026-08-09T08%3A00%3A00.000Z')));
    assert.equal((today.items as Array<{ id: string }>).some((item) => item.id === commitmentId), true);
  } finally {
    cleanup();
  }
});

test('every route in this file refuses an unauthenticated caller', async () => {
  const cleanup = setup();
  try {
    const calls: Array<[string, Promise<Response>]> = [
      ['capture', capturePost(anonymousRequest('/api/mobile/capture', { text: 'Call the dentist tomorrow at 3pm', referenceTime, timezone: 'UTC' }))],
      ['confirm', confirmPost(anonymousRequest('/api/mobile/capture/confirm', { proposalId: 'p', itemIds: ['i'] }))],
      ['today', todayGet(anonymousRequest('/api/mobile/commitments/today'))],
      ['upcoming', upcomingGet(anonymousRequest('/api/mobile/commitments/upcoming'))],
      ['detail', commitmentGet(anonymousRequest('/api/mobile/commitments/c1'), params('c1'))],
      ['action', actionPost(anonymousRequest('/api/mobile/commitments/c1/actions', { action: 'complete' }), params('c1'))],
      ['delete', commitmentDelete(anonymousRequest('/api/mobile/commitments/c1'), params('c1'))],
    ];
    for (const [name, pending] of calls) {
      const response = await pending;
      assert.equal(response.status, 401, `${name} must refuse an unauthenticated caller`);
      assert.equal((await json(response)).reason, 'missing_token', name);
    }
    assert.equal(await commitmentCount(), 0);
  } finally {
    cleanup();
  }
});
