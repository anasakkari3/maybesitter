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
import { GET as healthGet } from '../../src/app/api/health/route.ts';
import { getPilotTrustStore } from '../../lib/pilot/pilotTrustStore.ts';

const baseUrl = 'http://127.0.0.1:4321';
const referenceTime = '2026-08-09T08:00:00.000Z';
const TEST_SECRET = 'test-secret-min-16-chars-long-security-key';

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function setupIsolationTestEnv(): { cleanup: () => void; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-isolation-test-'));
  const allowlistIds = Array.from({ length: 40 }, (_, i) => `p-${100 + i}`).join(',');
  process.env.MAYBESITTER_CLOSED_PILOT_IDS = allowlistIds;
  process.env.MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID = 'p-100';
  process.env.MAYBESITTER_PILOT_TOKEN_SECRET = TEST_SECRET;
  process.env.MAYBESITTER_DATA_DIR = dir;
  
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Blocker 3 Test: Secret Hardening & Token Security Invariants', async () => {
  const { cleanup } = setupIsolationTestEnv();
  try {
    // 1. Missing secret in production environment throws error
    const oldSecret = process.env.MAYBESITTER_PILOT_TOKEN_SECRET;
    delete process.env.MAYBESITTER_PILOT_TOKEN_SECRET;
    assert.throws(
      () => generatePilotToken('p-120'),
      /MAYBESITTER_PILOT_TOKEN_SECRET environment variable is required/
    );
    assert.equal(parseAndValidatePilotToken('p-token.p-120.1234.5678').valid, false);
    process.env.MAYBESITTER_PILOT_TOKEN_SECRET = oldSecret;

    // 2. Explicit test secret works
    process.env.MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID = 'p-120';
    const validToken = generatePilotToken('p-120', TEST_SECRET);
    assert.equal(validToken.startsWith('p-token.p-120.'), true);
    const parsed = parseAndValidatePilotToken(validToken, TEST_SECRET);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.participantId, 'p-120');

    // 3. Tampered signature fails validation
    const tampered = validToken.replace(/\.[a-f0-9]+$/, '.deadbeef');
    assert.equal(parseAndValidatePilotToken(tampered, TEST_SECRET).valid, false);

    // 4. Token generated under Secret A fails validation under Secret B
    const secretB = 'different-secret-key-min-16-chars-long';
    const tokenA = generatePilotToken('p-120', TEST_SECRET);
    assert.equal(parseAndValidatePilotToken(tokenA, secretB).valid, false);
  } finally {
    cleanup();
  }
});

test('Health Check Route Test: Unauthenticated health check endpoint', async () => {
  const res = await healthGet();
  assert.equal(res.status, 200);
  const body = await res.json() as { status: string; service: string };
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'maybesitter-pilot-backend');
});

test('Storage & Domain State Isolation Test 1: Participant A file state isolated from Participant B', async () => {
  const { cleanup, dir } = setupIsolationTestEnv();
  try {
    const fileA = join(dir, 'p-100-state.json');
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
        scopeId: 'p-100',
      }),
    }));
    const proposal = await proposalRes.json() as { proposalId: string; items: Array<{ itemId: string }> };
    const confirmRes = await confirmPost(new Request(`${baseUrl}/api/mobile/capture/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: proposal.proposalId,
        scopeId: 'p-100',
        itemIds: [proposal.items[0].itemId],
      }),
    }));
    const confirmation = await confirmRes.json() as { persisted: Array<{ commitmentId: string }> };
    const commitmentIdA = confirmation.persisted[0].commitmentId;

    // Switch state file to Participant B
    const fileB = join(dir, 'p-101-state.json');
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

test('Storage & Domain State Isolation Test 2: Participant A state cannot be mutated from Participant B context', async () => {
  const { cleanup, dir } = setupIsolationTestEnv();
  try {
    const fileA = join(dir, 'p-100-state.json');
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
        scopeId: 'p-100',
      }),
    }));
    const proposal = await proposalRes.json() as { proposalId: string; items: Array<{ itemId: string }> };
    const confirmRes = await confirmPost(new Request(`${baseUrl}/api/mobile/capture/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: proposal.proposalId,
        scopeId: 'p-100',
        itemIds: [proposal.items[0].itemId],
      }),
    }));
    const confirmation = await confirmRes.json() as { persisted: Array<{ commitmentId: string }> };
    const commitmentIdA = confirmation.persisted[0].commitmentId;

    const fileB = join(dir, 'p-101-state.json');
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

test('Domain Control Test: Non-allowlisted or revoked token validation fails closed', async () => {
  const { cleanup } = setupIsolationTestEnv();
  try {
    // Non-allowlisted participant token
    const nonAllowlistedToken = generatePilotToken('p-999', TEST_SECRET);
    const nonRes = parseAndValidatePilotToken(nonAllowlistedToken, TEST_SECRET);
    assert.equal(nonRes.valid, false);

    // Revoked participant token (p-100)
    const store = getPilotTrustStore();
    const current = store.getOrCreate('p-100', new Date().toISOString());
    if (!current.revokedAt) {
      store.apply('p-100', { type: 'revoke', at: new Date().toISOString() });
    }

    const revokedToken = generatePilotToken('p-100', TEST_SECRET);
    const revokedRes = parseAndValidatePilotToken(revokedToken, TEST_SECRET);
    assert.equal(revokedRes.valid, false);
    assert.equal(revokedRes.reason, 'revoked');
  } finally {
    cleanup();
  }
});
