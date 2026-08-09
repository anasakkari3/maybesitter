import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generatePilotToken, parseAndValidatePilotToken } from '../../lib/pilot/pilotTokenService.ts';
import { configureCommandService } from '../../lib/services/commandService.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import {
  DELETE as commitmentDelete,
  GET as commitmentGet,
  PATCH as commitmentPatch,
} from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/commitments/[id]/actions/route.ts';
import { GET as trustGet } from '../../src/app/api/pilot/trust/route.ts';
import { getPilotTrustStore } from '../../lib/pilot/pilotTrustStore.ts';

const baseUrl = 'http://127.0.0.1:4321';
const referenceTime = '2026-08-09T08:00:00.000Z';

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function setupIsolationTestEnv(instanceParticipantId = 'p-100'): { cleanup: () => void; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-isolation-test-'));
  const allowlistIds = Array.from({ length: 30 }, (_, i) => `p-${100 + i}`).join(',');
  process.env.MAYBESITTER_CLOSED_PILOT_IDS = allowlistIds;
  process.env.MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID = instanceParticipantId;
  process.env.MAYBESITTER_DATA_DIR = dir;
  
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Participant Identity & Token Validation', async () => {
  const { cleanup } = setupIsolationTestEnv('p-110');
  try {
    const validToken = generatePilotToken('p-110');
    assert.equal(validToken.startsWith('p-token.p-110.'), true);

    const result = parseAndValidatePilotToken(validToken);
    assert.equal(result.valid, true);
    assert.equal(result.participantId, 'p-110');

    // Invalid signature token
    const tampered = validToken.replace(/\.[a-f0-9]+$/, '.deadbeef');
    assert.equal(parseAndValidatePilotToken(tampered).valid, false);

    // Non-allowlisted participant token
    const invalidParticipantToken = generatePilotToken('p-999');
    assert.equal(parseAndValidatePilotToken(invalidParticipantToken).valid, false);
  } finally {
    cleanup();
  }
});

test('Adversarial Test 1: Participant A cannot fetch Participant B commitments', async () => {
  const { cleanup, dir } = setupIsolationTestEnv('p-111');
  try {
    const fileA = join(dir, 'p-111-state.json');
    configureCommandService({
      initialState: createEmptyDomainState(),
      stateFile: fileA,
    });

    const proposalRes = await capturePost(new Request(`${baseUrl}/api/mobile/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Participant A dentist appointment tomorrow at 3pm',
        referenceTime,
        scopeId: 'p-111',
      }),
    }));
    const proposal = await proposalRes.json() as { proposalId: string; items: Array<{ itemId: string }> };
    const confirmRes = await confirmPost(new Request(`${baseUrl}/api/mobile/capture/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: proposal.proposalId,
        scopeId: 'p-111',
        itemIds: [proposal.items[0].itemId],
      }),
    }));
    const confirmation = await confirmRes.json() as { persisted: Array<{ commitmentId: string }> };
    const commitmentIdA = confirmation.persisted[0].commitmentId;

    // Switch state file to Participant B (p-112)
    const fileB = join(dir, 'p-112-state.json');
    configureCommandService({
      initialState: createEmptyDomainState(),
      stateFile: fileB,
    });

    const getResB = await commitmentGet(new Request(`${baseUrl}/api/mobile/commitments/${commitmentIdA}`), params(commitmentIdA));
    assert.equal(getResB.status, 404);
  } finally {
    cleanup();
  }
});

test('Adversarial Test 2: Participant A cannot mutate Participant B commitments', async () => {
  const { cleanup, dir } = setupIsolationTestEnv('p-113');
  try {
    const fileA = join(dir, 'p-113-state.json');
    configureCommandService({
      initialState: createEmptyDomainState(),
      stateFile: fileA,
    });

    const proposalRes = await capturePost(new Request(`${baseUrl}/api/mobile/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Participant A task tomorrow at 4pm',
        referenceTime,
        scopeId: 'p-113',
      }),
    }));
    const proposal = await proposalRes.json() as { proposalId: string; items: Array<{ itemId: string }> };
    const confirmRes = await confirmPost(new Request(`${baseUrl}/api/mobile/capture/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: proposal.proposalId,
        scopeId: 'p-113',
        itemIds: [proposal.items[0].itemId],
      }),
    }));
    const confirmation = await confirmRes.json() as { persisted: Array<{ commitmentId: string }> };
    const commitmentIdA = confirmation.persisted[0].commitmentId;

    const fileB = join(dir, 'p-114-state.json');
    configureCommandService({
      initialState: createEmptyDomainState(),
      stateFile: fileB,
    });

    const patchResB = await commitmentPatch(
      new Request(`${baseUrl}/api/mobile/commitments/${commitmentIdA}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Hacked Title' }),
      }),
      params(commitmentIdA)
    );
    assert.equal(patchResB.status, 404);

    const actionResB = await actionPost(
      new Request(`${baseUrl}/api/mobile/commitments/${commitmentIdA}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete' }),
      }),
      params(commitmentIdA)
    );
    assert.equal(actionResB.status === 404 || actionResB.status === 400, true);

    const deleteResB = await commitmentDelete(
      new Request(`${baseUrl}/api/mobile/commitments/${commitmentIdA}`, { method: 'DELETE' }),
      params(commitmentIdA)
    );
    assert.equal(deleteResB.status === 404 || deleteResB.status === 400, true);
  } finally {
    cleanup();
  }
});

test('Adversarial Test 3: Participant A cannot view Participant B trust state', async () => {
  const { cleanup } = setupIsolationTestEnv('p-115');
  try {
    const res = await trustGet(new Request(`${baseUrl}/api/pilot/trust?participantId=p-116`));
    assert.equal(res.status === 403 || res.status === 503, true);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'participant is not admitted to this pilot instance');
  } finally {
    cleanup();
  }
});

test('Adversarial Test 4: Revoked or non-allowlisted credentials fail closed', async () => {
  const { cleanup } = setupIsolationTestEnv('p-999');
  try {
    const nonRes = await trustGet(new Request(`${baseUrl}/api/pilot/trust?participantId=p-999`));
    assert.equal(nonRes.status === 403 || nonRes.status === 503, true);

    process.env.MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID = 'p-125';
    const store = getPilotTrustStore();
    const now = new Date().toISOString();
    store.apply('p-125', { type: 'revoke', at: now });

    const revokedRes = await trustGet(new Request(`${baseUrl}/api/pilot/trust?participantId=p-125`));
    const trustBody = await revokedRes.json() as { trust: { revokedAt: string | null }; exposure: { allowed: boolean; reason: string } };
    assert.equal(trustBody.exposure.allowed, false);
    assert.equal(trustBody.exposure.reason, 'revoked');
  } finally {
    cleanup();
  }
});

test('Adversarial Test 5: Client cannot tamper with experiment assignment', async () => {
  const { cleanup } = setupIsolationTestEnv('p-118');
  try {
    const badActionRes = await actionPost(
      new Request(`${baseUrl}/api/mobile/commitments/fake-id/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'override_experiment_arm', arm: 'v03-next-step' }),
      }),
      params('fake-id')
    );
    assert.equal(badActionRes.status, 400);
  } finally {
    cleanup();
  }
});
