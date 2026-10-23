import assert from 'node:assert/strict';
import test from 'node:test';
import type { Commitment } from '../../src/domain/stateMachine.ts';
import type { GmailTransport } from '../../lib/integrations/gmail/production/gmailTransport.ts';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime.ts';
import { connectionIdFor } from '../../lib/integrations/providers/production/storedConnectionStore.ts';
import {
  INTELLIGENCE_AUTO_ADDS,
  INTELLIGENCE_GMAIL_SCANS,
  INTELLIGENCE_OBSERVATIONS,
  INTELLIGENCE_SOURCE_MARKERS,
  PROVIDER_CONNECTIONS,
  userCol,
  userSubDoc,
} from '../../lib/storage/index.ts';
import { commitmentDocPath } from '../../lib/services/mobile/participantState.ts';
import { analyzeArbitratedGmailMessage } from '../../lib/intelligence/gmailArbitration.ts';
import {
  autoAddPath,
  commitmentBaselineFingerprint,
  removeAutoAdd,
  type AutoAddRecord,
} from '../../lib/intelligence/autoAdds.ts';
import { runM5aScanStep } from '../../lib/intelligence/m5aGmailScan.ts';
import {
  observationId,
  observationPath,
  putObservations,
  reviewObservation,
  type StoredObservation,
} from '../../lib/intelligence/observationStore.ts';
import {
  NOW,
  begin,
  currentStorage,
  end,
  markDeletedNow,
  spyStorage,
  sweepAccountNow,
  userPaths,
} from '../acceptance/m5b2b1/support.ts';

test.afterEach(() => end());

const ACCOUNT_BOUNDARIES = [
  ['markDeleted', markDeletedNow],
  ['the user-tree sweep', sweepAccountNow],
] as const;

const MAIL_AT = '2026-10-19T09:00:00.000Z';
const PROVIDER_ACCOUNT = 'acct-778';

function gmailMessage(id: string) {
  return {
    id,
    threadId: null,
    historyId: '778',
    receivedAt: MAIL_AT,
    from: null,
    subject: null,
    text: 'Please send the report',
    sentByAccount: false,
    isReply: false,
    bodyFormat: 'text/plain' as const,
  };
}

function semanticReply() {
  return {
    text: JSON.stringify({ observations: [{ kind: 'request', evidence: 'Please send the report', confidence: 0.9 }] }),
    model: 'fake',
    latencyMs: 1,
    promptTokens: 1,
    outputTokens: 1,
  };
}

function runtime(storage: any, duringModel?: () => Promise<void>): GoogleRuntime {
  return {
    storage,
    env: { MAYBESITTER_ENV: 'staging' } as GoogleRuntime['env'],
    secrets: null,
    fetchImpl: fetch,
    now: () => new Date(MAIL_AT),
    shareModel: async () => {
      await duringModel?.();
      return semanticReply();
    },
  };
}

function intelligenceRows(uid: string): string[] {
  return userPaths(uid).filter(path => /\/intelligence(?:Observations|SourceMarkers|AutoAdds|GmailScans)\//.test(path));
}

for (const [boundary, deleteAccount] of ACCOUNT_BOUNDARIES) {
  test(`#778 Gmail arbitration claim writes nothing after ${boundary}`, async () => {
    const uid = await begin();
    await deleteAccount(uid);
    let calls = 0;
    const result = await analyzeArbitratedGmailMessage(uid, PROVIDER_ACCOUNT, gmailMessage(`claim-${boundary}`), {
      ...runtime(currentStorage()),
      shareModel: async () => { calls += 1; return semanticReply(); },
    });

    assert.equal(result.kind, 'blocked');
    assert.deepEqual(result.observations, []);
    assert.equal(calls, 0, 'a deleted account reached semantic analysis');
    assert.deepEqual(intelligenceRows(uid), [], 'the claim recreated an intelligence row');
    if (boundary === 'the user-tree sweep') assert.deepEqual(userPaths(uid), []);
  });

  test(`#778 Gmail arbitration commit writes no observation after ${boundary}`, async () => {
    const uid = await begin();
    const result = await analyzeArbitratedGmailMessage(
      uid,
      PROVIDER_ACCOUNT,
      gmailMessage(`commit-${boundary}`),
      runtime(currentStorage(), () => deleteAccount(uid)),
    );

    assert.equal(result.kind, 'blocked');
    assert.deepEqual(result.observations, []);
    assert.deepEqual(await currentStorage().list(userCol(uid, INTELLIGENCE_OBSERVATIONS)), []);
    if (boundary === 'the user-tree sweep') assert.deepEqual(userPaths(uid), []);
  });
}

async function seedManualScan(uid: string): Promise<string> {
  const storage = currentStorage();
  const path = `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/manualV2`;
  await storage.set('system/m5aControls', {
    email: { epoch: 7, enabled: true },
    calendar: { epoch: 1, enabled: true },
  });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: PROVIDER_ACCOUNT },
    state: 'connected',
    credentialRef: 'vault',
    capabilities: ['mail_read'],
    grantedScopes: [],
  });
  await storage.set(path, {
    scanId: 'scan-778', kind: 'manual', status: 'running', origin: 'manual',
    providerAccountId: PROVIDER_ACCOUNT, emailEpoch: 7, query: 'after:1 before:9999999999',
    from: '2026-10-19T08:00:00.000Z', until: '2026-10-19T10:00:00.000Z', timezone: 'UTC',
    startedAt: MAIL_AT, finishedAt: null, failedAt: null, failure: null, pageToken: null,
    page: { ids: ['scan-mail-778'], nextPageToken: null, done: [] }, leaseOwner: null, leaseUntil: null,
    queued: null, nextEligibleAt: MAIL_AT, waiting: null, messagesRead: 0, messagesUnavailable: 0,
    messagesTrimmed: 0, observationsFound: 0, addedFromEmail: 0,
  });
  return path;
}

for (const [boundary, deleteAccount] of ACCOUNT_BOUNDARIES) {
  test(`#778 M5a scan/auto-add commit writes nothing after ${boundary}`, async () => {
    const uid = await begin();
    await seedManualScan(uid);
    const message = gmailMessage('scan-mail-778');
    await runM5aScanStep(
      uid,
      'manual',
      runtime(currentStorage(), () => deleteAccount(uid)),
      { getMessageById: async () => message } as unknown as GmailTransport,
      async () => undefined,
    );

    assert.deepEqual(await currentStorage().list(userCol(uid, INTELLIGENCE_OBSERVATIONS)), []);
    assert.deepEqual(await currentStorage().list(userCol(uid, INTELLIGENCE_AUTO_ADDS)), []);
    if (boundary === 'the user-tree sweep') assert.deepEqual(userPaths(uid), []);
  });
}

test('#778 M5a message claim writes no marker when markDeleted lands immediately before it', async () => {
  const uid = await begin();
  await seedManualScan(uid);
  let fired = false;
  const storage = spyStorage(currentStorage(), {
    afterRead: async (method, path) => {
      if (fired || method !== 'get' || typeof path !== 'string' || !path.includes(`/${INTELLIGENCE_SOURCE_MARKERS}/`)) return;
      fired = true;
      await markDeletedNow(uid);
    },
  });
  await runM5aScanStep(
    uid,
    'manual',
    runtime(storage),
    { getMessageById: async () => gmailMessage('scan-mail-778') } as unknown as GmailTransport,
    async () => undefined,
  );

  assert.equal(fired, true, 'fixture never reached the pre-claim marker read');
  assert.deepEqual(await currentStorage().list(userCol(uid, INTELLIGENCE_SOURCE_MARKERS)), []);
});

function commitment(autoAddId: string): Commitment {
  return {
    id: 'commitment-778', kind: 'task', title: 'Send the report', description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: '2026-10-20T08:00:00.000Z', endAt: null,
      remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen', postponedUntil: null, createdAt: MAIL_AT, updatedAt: MAIL_AT,
    confirmedAt: MAIL_AT, completedAt: null, droppedAt: null,
    addedFrom: { kind: 'email_self_reply', autoAddId },
  };
}

async function seedAutoAdd(uid: string) {
  const storage = currentStorage();
  const autoAddId = 'a'.repeat(64);
  const observation: StoredObservation = {
    id: observationId('gmail', 'mail-778', { kind: 'commitment', evidence: 'I will send the report', confidence: 0.9 }),
    kind: 'commitment', evidence: 'I will send the report', confidence: 0.9, source: 'gmail', sourceRef: 'mail-778',
    observedAt: MAIL_AT, review: 'confirmed', reviewedAt: MAIL_AT, linkedMemoryId: null, autoAddId,
  };
  const saved = commitment(autoAddId);
  const record: AutoAddRecord = {
    autoAddId, providerAccountId: PROVIDER_ACCOUNT, commitmentId: saved.id, observationIds: [observation.id],
    evidence: 'I will send the report', baseline: commitmentBaselineFingerprint(saved), at: MAIL_AT, removedAt: null,
  };
  await storage.set(commitmentDocPath(uid, saved.id), saved);
  await storage.set(observationPath(uid, observation.id), observation);
  await storage.set(autoAddPath(uid, autoAddId), record);
  return { autoAddId, observation, saved, record };
}

for (const [boundary, deleteAccount] of ACCOUNT_BOUNDARIES) {
  test(`#778 auto-add removal writes nothing after ${boundary}`, async () => {
    const uid = await begin();
    const fixture = await seedAutoAdd(uid);
    const storage = currentStorage() as any;
    storage.setBeforeCommitHookForTests(async ({ attempt }: { attempt: number }) => {
      if (attempt !== 1) return;
      storage.setBeforeCommitHookForTests(null);
      await deleteAccount(uid);
    });

    const result = await removeAutoAdd(uid, fixture.autoAddId, NOW(), storage);
    assert.equal(result, 'missing');
    if (boundary === 'the user-tree sweep') {
      assert.deepEqual(userPaths(uid), []);
    } else {
      assert.deepEqual(await storage.get(commitmentDocPath(uid, fixture.saved.id)), fixture.saved);
      assert.deepEqual(await storage.get(observationPath(uid, fixture.observation.id)), fixture.observation);
      assert.deepEqual(await storage.get(autoAddPath(uid, fixture.autoAddId)), fixture.record);
    }
  });
}

for (const [boundary, deleteAccount] of ACCOUNT_BOUNDARIES) {
  test(`#778 putObservations returns empty and writes nothing after ${boundary}`, async () => {
    const uid = await begin();
    await deleteAccount(uid);
    const rows = await putObservations(uid, 'manual', `put-${boundary}`, NOW(), [{
      kind: 'request', evidence: 'Please send the report', confidence: 0.9,
    }], currentStorage() as any);

    assert.deepEqual(rows, []);
    assert.deepEqual(await currentStorage().list(userCol(uid, INTELLIGENCE_OBSERVATIONS)), []);
    if (boundary === 'the user-tree sweep') assert.deepEqual(userPaths(uid), []);
  });
}

async function seedPendingObservation(uid: string, kind: StoredObservation['kind'] = 'request') {
  const item = { kind, evidence: kind === 'goal' ? 'Learn Arabic' : 'Please send the report', confidence: 0.9 };
  const id = observationId('manual', `review-${kind}`, item);
  const observation: StoredObservation = {
    ...item, id, source: 'manual', sourceRef: `review-${kind}`, observedAt: MAIL_AT,
    review: 'pending', reviewedAt: null, linkedMemoryId: null,
  };
  await currentStorage().set(observationPath(uid, id), observation);
  return observation;
}

for (const [boundary, deleteAccount] of ACCOUNT_BOUNDARIES) {
  test(`#778 observation review claim writes nothing after ${boundary}`, async () => {
    const uid = await begin();
    const observation = await seedPendingObservation(uid);
    const storage = currentStorage() as any;
    storage.setBeforeCommitHookForTests(async ({ attempt }: { attempt: number }) => {
      if (attempt !== 1) return;
      storage.setBeforeCommitHookForTests(null);
      await deleteAccount(uid);
    });

    const result = await reviewObservation(uid, observation.id, 'dismissed', NOW(), storage);
    assert.equal(result, null);
    if (boundary === 'the user-tree sweep') assert.deepEqual(userPaths(uid), []);
    else assert.deepEqual(await storage.get(observationPath(uid, observation.id)), observation);
  });

  test(`#778 observation linkedMemoryId write does nothing after ${boundary}`, async () => {
    const uid = await begin();
    const observation = await seedPendingObservation(uid, 'goal');
    let observationReads = 0;
    const storage = spyStorage(currentStorage(), {
      afterRead: async (method, path) => {
        if (method !== 'tx.get' || path !== observationPath(uid, observation.id)) return;
        observationReads += 1;
        if (observationReads === 2) await deleteAccount(uid);
      },
    });

    const result = await reviewObservation(uid, observation.id, 'confirmed', NOW(), storage);
    assert.equal(observationReads >= 2, true, 'fixture never reached the linkedMemoryId transaction');
    assert.equal(result, null);
    if (boundary === 'the user-tree sweep') {
      assert.deepEqual(userPaths(uid), []);
    } else {
      const stored = await currentStorage().get<StoredObservation>(observationPath(uid, observation.id));
      assert.equal(stored?.review, 'confirmed');
      assert.equal(stored?.linkedMemoryId, null);
    }
  });
}
