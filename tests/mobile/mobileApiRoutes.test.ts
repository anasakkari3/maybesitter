import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configureCommandService, getCommandServiceState } from '../../lib/services/commandService.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
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

const baseUrl = 'http://127.0.0.1:4321';
const referenceTime = '2026-08-09T08:00:00.000Z';

function request(path: string, body?: unknown): Request {
  return new Request(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
    stateFile: join(dir, 'domain-state.json'),
  });
  return () => rmSync(dir, { recursive: true, force: true });
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
  assert.equal(Object.keys(getCommandServiceState().commitments).length, 0);

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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
      assert.equal(Object.keys(getCommandServiceState().commitments).length, 0);
    }

    const malformed = await capturePost(request('/api/mobile/capture', {
      text: 'Call Maya tomorrow at 3pm',
      referenceTime: 'not-a-time',
      timezone: 'UTC',
      scopeId: 'safety-test',
    }));
    assert.equal(malformed.status, 400);
    assert.equal(Object.keys(getCommandServiceState().commitments).length, 0);
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
      assert.equal(Object.keys(getCommandServiceState().commitments).length, 0);
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

    const wrongScope = await confirmPost(request('/api/mobile/capture/confirm', {
      proposalId: proposal.proposalId,
      scopeId: 'other',
      itemIds: [items[0].itemId],
    }));
    assert.equal(wrongScope.status, 200);
    assert.equal((await json(wrongScope)).success, false);
    assert.equal(Object.keys(getCommandServiceState().commitments).length, 0);

    const emptySelection = await confirmPost(request('/api/mobile/capture/confirm', {
      proposalId: proposal.proposalId,
      scopeId: 'owner',
      itemIds: [],
    }));
    assert.equal(emptySelection.status, 400);
    assert.equal(Object.keys(getCommandServiceState().commitments).length, 0);
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
    const countAfterFirst = Object.keys(getCommandServiceState().commitments).length;
    const second = await json(await confirmPost(request('/api/mobile/capture/confirm', payload)));

    assert.equal(first.success, true);
    assert.equal(first.replayed, false);
    assert.equal(second.success, true);
    assert.equal(second.replayed, true);
    assert.equal(Object.keys(getCommandServiceState().commitments).length, countAfterFirst);
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
    const stateAfterFirst = JSON.stringify(getCommandServiceState().commitments);
    const second = await json(await confirmPost(request('/api/mobile/capture/confirm', {
      proposalId: proposal.proposalId,
      scopeId: 'mismatch',
      itemIds: [itemId],
      idempotencyKey: 'key-b',
    })));

    assert.equal(first.success, true);
    assert.equal(second.success, false);
    assert.deepEqual(second.failed, [{ itemId, reason: 'invalid_selection' }]);
    assert.equal(Object.keys(getCommandServiceState().commitments).length, 1);
    assert.equal(JSON.stringify(getCommandServiceState().commitments), stateAfterFirst);
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
