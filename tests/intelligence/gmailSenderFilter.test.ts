import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  GMAIL_SENDER_STATS,
  INTELLIGENCE_GMAIL_SCANS,
  INTELLIGENCE_SOURCE_MARKERS,
  PROVIDER_CONNECTIONS,
  createMemoryStorage,
  userCol,
  userSubDoc,
} from '../../lib/storage/index.ts';
import {
  SENDER_EMPTY_THRESHOLD,
  SUBJECT_EMPTY_THRESHOLD,
  createGmailSenderStatsStore,
  decide,
  isSenderFilterAuditSample,
  normalizeSubject,
  senderKey,
  subjectKey,
  type GmailSenderStats,
} from '../../lib/intelligence/gmailSenderFilter.ts';
import { runM5aScanStep, providerMarkerIdFor, type M5aMarker } from '../../lib/intelligence/m5aGmailScan.ts';
import { runGmailMonitorTick, type GmailMonitor } from '../../lib/intelligence/gmailMonitor.ts';
import type { GmailMessagePayload } from '../../lib/integrations/gmail/adapter.ts';
import type { GmailTransport } from '../../lib/integrations/gmail/production/gmailTransport.ts';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime.ts';
import { GOOGLE_FEATURE_SCOPES } from '../../lib/integrations/google/googleConfig.ts';
import { connectionIdFor } from '../../lib/integrations/providers/production/storedConnectionStore.ts';
import { createPilotTrustState } from '../../lib/pilot/closedPilotControls.ts';

const NOW = '2026-11-12T10:00:00.000Z';
const UID = 'gmail-filter-user';
const FROM = 'AliExpress <updates@aliexpress.example>';
const SUBJECT = 'Order 123456 shipped';

function firstMessageId(audited: boolean): string {
  for (let index = 0; index < 10_000; index += 1) {
    const id = `mail-${audited ? 'audit' : 'ordinary'}-${index}`;
    if (isSenderFilterAuditSample(id) === audited) return id;
  }
  throw new Error('could not find deterministic audit fixture');
}

function stats(overrides: Partial<GmailSenderStats> = {}): GmailSenderStats {
  const key = subjectKey(UID, SUBJECT);
  return {
    v: 1,
    senderKey: senderKey(UID, FROM),
    fullyRead: SENDER_EMPTY_THRESHOLD,
    produced: 0,
    skipped: 0,
    subjects: { [key]: { fullyRead: SUBJECT_EMPTY_THRESHOLD, produced: 0, skipped: 0 } },
    displayAddress: 'updates@aliexpress.example',
    repliedTo: false,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function decisionMessage(id = firstMessageId(false), overrides: Record<string, unknown> = {}) {
  return {
    id,
    subjectKey: subjectKey(UID, SUBJECT),
    conversationReply: false,
    sentByAccount: false,
    starred: false,
    ...overrides,
  };
}

test('normalizeSubject strips repeated multilingual reply/forward prefixes, folds case, digits and spaces', () => {
  assert.equal(normalizeSubject('  Re: FWD[2]: ORDER 12345   Shipped  '), 'order # shipped');
  assert.equal(normalizeSubject('رد: تحويل: طلب ٩٨٧ جاهز'), 'طلب # جاهز');
  assert.equal(normalizeSubject('השב: הועבר: Invoice 42'), 'invoice #');
});

test('the fifth empty mail makes the next matching sender or subject skippable', () => {
  assert.equal(SENDER_EMPTY_THRESHOLD, 5);
  assert.equal(SUBJECT_EMPTY_THRESHOLD, 5);
  assert.deepEqual(decide(stats(), decisionMessage()), {
    action: 'skip', reason: 'sender_and_subject_empty', audited: false,
  });
  assert.equal(decide(stats({ subjects: {} }), decisionMessage()).reason, 'sender_empty');
  assert.equal(decide(stats({ fullyRead: 1, produced: 1 }), decisionMessage()).reason, 'subject_empty');
  assert.equal(decide(stats({ fullyRead: 4, subjects: {} }), decisionMessage()).action, 'read');
});

test('a sender that produced once is still read after ten later empty mails', async () => {
  const storage = createMemoryStorage();
  await storage.set(`users/${UID}`, { trust: createPilotTrustState(UID, NOW) });
  const store = createGmailSenderStatsStore(storage);
  await store.recordFullRead(UID, {
    id: 'producing-sender-mail', from: FROM, subject: 'Decision needed', sentByAccount: false, isReply: false, starred: false,
  }, true, NOW);
  for (let index = 0; index < 10; index += 1) {
    await store.recordFullRead(UID, {
      id: `later-empty-${index}`, from: FROM, subject: `FYI ${index}`, sentByAccount: false, isReply: false, starred: false,
    }, false, NOW);
  }

  const remembered = await store.getForMessage(UID, { from: FROM, subject: 'A new topic' });
  assert.equal(remembered?.fullyRead, 11);
  assert.equal(remembered?.produced, 1);
  assert.deepEqual(decide(remembered, decisionMessage(firstMessageId(false), {
    subjectKey: subjectKey(UID, 'A new topic'),
  })), { action: 'read', reason: 'below_threshold', audited: false });
});

test('a subject that produced once is never skipped after later empty mails', async () => {
  const storage = createMemoryStorage();
  await storage.set(`users/${UID}`, { trust: createPilotTrustState(UID, NOW) });
  const store = createGmailSenderStatsStore(storage);
  await store.recordFullRead(UID, {
    id: 'producing-subject-mail', from: FROM, subject: SUBJECT, sentByAccount: false, isReply: false, starred: false,
  }, true, NOW);
  for (let index = 0; index < 10; index += 1) {
    await store.recordFullRead(UID, {
      id: `same-subject-empty-${index}`, from: FROM, subject: SUBJECT, sentByAccount: false, isReply: false, starred: false,
    }, false, NOW);
  }

  const remembered = await store.getForMessage(UID, { from: FROM, subject: SUBJECT });
  const rememberedSubject = remembered?.subjects[subjectKey(UID, SUBJECT)];
  assert.deepEqual(rememberedSubject, { fullyRead: 11, produced: 1, skipped: 0 });
  assert.deepEqual(decide(remembered, decisionMessage()), {
    action: 'read', reason: 'below_threshold', audited: false,
  });
});

test('sender and subject keys reject a missing salt in production-like environments', () => {
  assert.throws(
    () => senderKey(UID, FROM, { MAYBESITTER_ENV: 'staging' }),
    /MAYBESITTER_LLM_UID_SALT/,
  );
  assert.throws(
    () => subjectKey(UID, SUBJECT, { MAYBESITTER_ENV: 'production' }),
    /MAYBESITTER_LLM_UID_SALT/,
  );
  assert.equal(senderKey(UID, FROM, { MAYBESITTER_ENV: 'local' }), senderKey(UID, FROM, {}));
});

test('replies, replied-to senders and starred mail are never skipped', () => {
  assert.equal(decide(stats(), decisionMessage(firstMessageId(false), { conversationReply: true })).reason, 'conversation_reply');
  assert.equal(decide(stats({ repliedTo: true }), decisionMessage()).reason, 'replied_to_sender');
  assert.equal(decide(stats(), decisionMessage(firstMessageId(false), { starred: true })).reason, 'starred');
  assert.equal(decide(stats(), decisionMessage(firstMessageId(false), { sentByAccount: true })).reason, 'sent_by_account');
});

test('the five-percent audit sample is deterministic and reads an otherwise skipped mail', () => {
  const audited = firstMessageId(true);
  assert.equal(isSenderFilterAuditSample(audited), true);
  assert.equal(isSenderFilterAuditSample(audited), true);
  assert.deepEqual(decide(stats(), decisionMessage(audited)), {
    action: 'read', reason: 'audit_sample', audited: true,
  });
});

test('an audited hit immediately removes the sender and subject from skipping', async () => {
  const storage = createMemoryStorage();
  await storage.set(`users/${UID}`, { trust: createPilotTrustState(UID, NOW) });
  const store = createGmailSenderStatsStore(storage);
  for (let index = 0; index < 5; index += 1) {
    await store.recordFullRead(UID, {
      id: `empty-${index}`, from: FROM, subject: SUBJECT, sentByAccount: false, isReply: false, starred: false,
    }, false, NOW);
  }
  const before = await store.getForMessage(UID, { from: FROM, subject: SUBJECT });
  assert.equal(decide(before, decisionMessage()).action, 'skip');
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (line?: unknown) => { warnings.push(String(line)); };
  try {
    await store.recordFullRead(UID, {
      id: firstMessageId(true), from: FROM, subject: SUBJECT, sentByAccount: false, isReply: false, starred: false,
    }, true, NOW, { audited: true });
  } finally {
    console.warn = originalWarn;
  }
  const after = await store.getForMessage(UID, { from: FROM, subject: SUBJECT });
  assert.equal(after?.fullyRead, 6);
  assert.equal(after?.produced, 1);
  assert.equal(decide(after, decisionMessage()).action, 'read');
  const laterSubjects = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  for (const laterSubject of laterSubjects) {
    await store.recordFullRead(UID, {
      id: `after-audit-${laterSubject}`, from: FROM, subject: laterSubject, sentByAccount: false, isReply: false, starred: false,
    }, false, NOW);
  }
  const durable = await store.getForMessage(UID, { from: FROM, subject: null });
  assert.equal(durable?.fullyRead, 16);
  assert.equal(durable?.produced, 1);
  assert.deepEqual(decide(durable, decisionMessage(firstMessageId(false), { subjectKey: null })), {
    action: 'read', reason: 'below_threshold', audited: false,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /gmail_sender_filter_audit_miss/);
  assert.doesNotMatch(warnings[0]!, /AliExpress|updates@|Order|123456/i);
});

test('a fully read sent reply remembers its recipients as replied-to senders', async () => {
  const storage = createMemoryStorage();
  await storage.set(`users/${UID}`, { trust: createPilotTrustState(UID, NOW) });
  const store = createGmailSenderStatsStore(storage);
  await store.recordFullRead(UID, {
    id: 'sent-reply', from: 'me@example.com', subject: 'Re: plans', sentByAccount: true, isReply: true,
    starred: false, recipients: ['Friend <friend@example.com>'],
  }, false, NOW);
  const remembered = await store.getForMessage(UID, { from: 'Friend <friend@example.com>', subject: 'Plans' });
  assert.equal(remembered?.repliedTo, true);
  assert.equal(decide(remembered, decisionMessage(firstMessageId(false), {
    subjectKey: subjectKey(UID, 'Plans'),
  })).reason, 'replied_to_sender');
});

async function seedFiveEmpty(storage: ReturnType<typeof createMemoryStorage>, uid: string): Promise<void> {
  const store = createGmailSenderStatsStore(storage);
  for (let index = 0; index < 5; index += 1) {
    await store.recordFullRead(uid, {
      id: `seed-${index}`, from: FROM, subject: `Order ${1000 + index} shipped`, sentByAccount: false, isReply: false, starred: false,
    }, false, NOW);
  }
}

function message(id: string): GmailMessagePayload {
  return {
    id, threadId: id, historyId: '101', receivedAt: NOW, from: FROM, subject: SUBJECT,
    text: 'Your parcel is moving through the carrier network.', sentByAccount: false,
    isReply: false, isBulk: false, starred: false, bodyFormat: 'text/plain',
  };
}

test('M5a stage zero marks the sixth empty sender mail skipped without a model call', async () => {
  const storage = createMemoryStorage();
  const uid = 'm5a-filter-user';
  const id = firstMessageId(false);
  let modelCalls = 0;
  const runtime: GoogleRuntime = {
    storage,
    env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_GMAIL_SENDER_FILTER: 'on' } as GoogleRuntime['env'],
    secrets: null,
    fetchImpl: fetch,
    now: () => new Date(NOW),
    shareModel: async () => {
      modelCalls += 1;
      return { text: '{"observations":[]}', model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
  };
  await storage.set(`users/${uid}`, { trust: { ...createPilotTrustState(uid, NOW), calendarConsent: true } });
  await storage.set('system/m5aControls', { email: { epoch: 1, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(`${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/manualV2`, {
    scanId: 'scan-1', kind: 'manual', status: 'running', origin: 'manual', providerAccountId: 'acct', emailEpoch: 1,
    query: '', from: '2026-11-12T00:00:00.000Z', until: '2026-11-13T00:00:00.000Z', timezone: 'UTC',
    startedAt: NOW, finishedAt: null, failedAt: null, failure: null, pageToken: null,
    page: { ids: [id], nextPageToken: null, done: [] }, leaseOwner: null, leaseUntil: null, queued: null,
    nextEligibleAt: NOW, messagesRead: 0, messagesSkippedBulk: 0, messagesUnavailable: 0,
    messagesTrimmed: 0, observationsFound: 0, addedFromEmail: 0,
  });
  await seedFiveEmpty(storage, uid);
  const transport = { getMessageById: async () => message(id) } as unknown as GmailTransport;

  await runM5aScanStep(uid, 'manual', runtime, transport, async () => undefined);

  assert.equal(modelCalls, 0);
  const marker = await storage.get<M5aMarker>(
    `${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${providerMarkerIdFor(uid, 'acct', id)}`,
  );
  assert.equal(marker?.outcome, 'skipped_sender');
});

test('legacy Gmail monitor skips the sixth empty sender mail without a model call', async () => {
  const storage = createMemoryStorage();
  const uid = 'legacy-filter-user';
  const id = firstMessageId(false);
  let modelCalls = 0;
  await storage.set(`users/${uid}`, { trust: createPilotTrustState(uid, NOW) });
  await storage.set(`${userCol(uid, 'intelligenceMonitors')}/gmail`, {
    enabled: true, generation: 'enabled', cursor: '100', pageToken: null, nextPollAt: NOW,
    leaseUntil: null, lastSuccessAt: null, error: null,
  } satisfies GmailMonitor);
  await seedFiveEmpty(storage, uid);
  const runtime: GoogleRuntime = {
    storage,
    env: {
      MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true', MAYBESITTER_GMAIL_SENDER_FILTER: 'on',
    } as GoogleRuntime['env'],
    secrets: null,
    fetchImpl: fetch,
    now: () => new Date(NOW),
    shareModel: async () => {
      modelCalls += 1;
      return { text: '{"observations":[]}', model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
  };
  const transport = {
    listHistory: async () => ({ historyId: '101', nextPageToken: null, messages: [message(id)] }),
  } satisfies Pick<GmailTransport, 'listHistory'>;

  const result = await runGmailMonitorTick(runtime, { transport: () => transport, ensureReadable: async () => undefined });

  assert.equal(result.failures, 0);
  assert.equal(modelCalls, 0);
  const legacyId = createHash('sha256').update(`gmail\0${id}`).digest('hex');
  assert.equal((await storage.get<M5aMarker>(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${legacyId}`))?.outcome, 'skipped_sender');
  assert.equal((await storage.list(userCol(uid, GMAIL_SENDER_STATS))).length, 1);
});

test('legacy Gmail monitor keeps the original marker and never calls the sender filter when its flag is unset', async () => {
  const storage = createMemoryStorage();
  const uid = 'legacy-filter-off-user';
  const id = 'legacy-filter-off-mail';
  await storage.set(`users/${uid}`, { trust: createPilotTrustState(uid, NOW) });
  await storage.set(`${userCol(uid, 'intelligenceMonitors')}/gmail`, {
    enabled: true, generation: 'enabled', cursor: '100', pageToken: null, nextPollAt: NOW,
    leaseUntil: null, lastSuccessAt: null, error: null,
  } satisfies GmailMonitor);
  const runtime: GoogleRuntime = {
    storage,
    env: {
      MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true',
    } as GoogleRuntime['env'],
    secrets: null,
    fetchImpl: fetch,
    now: () => new Date(NOW),
    shareModel: async () => ({
      text: '{"observations":[]}', model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1,
    }),
  };
  const transport = {
    listHistory: async () => ({ historyId: '101', nextPageToken: null, messages: [message(id)] }),
  } satisfies Pick<GmailTransport, 'listHistory'>;

  const result = await runGmailMonitorTick(runtime, { transport: () => transport, ensureReadable: async () => undefined });

  assert.equal(result.failures, 0);
  const legacyId = createHash('sha256').update(`gmail\0${id}`).digest('hex');
  assert.deepEqual(
    await storage.get(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${legacyId}`),
    { processedAt: NOW },
  );
  assert.deepEqual(await storage.list(userCol(uid, GMAIL_SENDER_STATS)), []);
});
