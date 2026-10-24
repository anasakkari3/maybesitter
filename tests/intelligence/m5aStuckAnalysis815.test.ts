/**
 * #815: a message whose analysis keeps failing must not stall an M5a scan, and
 * the failed-scan sweep must not buy a paid model call for it every minute.
 *
 * - three failed analyses after a real dispatch finish the message as read but
 *   not analysed (`outcome: 'unanalysed'`, `messagesUnanalysed`), and the scan
 *   completes;
 * - a failed scan backs off 2, 4, 8, 16, then 30 minutes, and progress resets it;
 * - a daily-cap refusal or a permit whose minute ended before dispatch is a
 *   deferral, never an attempt;
 * - a transient failure that succeeds on a later attempt is analysed normally;
 * - a resume or a later scan counts the finished marker without the model;
 * - a free refusal before the paid call (kill switch, no provider) is never an
 *   attempt; an attempt is counted even when the scan fence moved, and a
 *   takeover of a claim that died after dispatch counts its lost attempt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTELLIGENCE_GMAIL_SCANS, INTELLIGENCE_SOURCE_MARKERS, PROVIDER_CONNECTIONS,
  createMemoryStorage, userSubDoc,
} from '../../lib/storage';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime';
import { GOOGLE_FEATURE_SCOPES } from '../../lib/integrations/google/googleConfig';
import { connectionIdFor } from '../../lib/integrations/providers/production/storedConnectionStore';
import { GmailProviderError } from '../../lib/integrations/gmail/adapter';
import type { GmailTransport } from '../../lib/integrations/gmail/production/gmailTransport';
import {
  M5A_MAX_ANALYSIS_ATTEMPTS, m5aRetryBackoffMs, markerDecision, providerMarkerIdFor, publicScanStatus, runM5aScanStep,
  type M5aMarker, type M5aScanDocument,
} from '../../lib/intelligence/m5aGmailScan';
import { M5A_USER_DAILY_CALL_CAP } from '../../lib/llm/usageGuard';
import type { LlmProvider, LlmStructuredRequest } from '../../src/extraction/llm/llmProvider';
import { createPilotTrustState } from '../../lib/pilot/closedPilotControls.ts';

const NOW = '2026-10-19T10:00:00.000Z';
const MINUTE = 60_000;
const at = (minutes: number): string => new Date(Date.parse(NOW) + minutes * MINUTE).toISOString();

const scanPath = (uid: string) => `users/${uid}/${INTELLIGENCE_GMAIL_SCANS}/manualV2`;
const markerPath = (uid: string, messageId: string) =>
  `users/${uid}/${INTELLIGENCE_SOURCE_MARKERS}/${providerMarkerIdFor(uid, 'acct', messageId)}`;

interface Harness {
  storage: ReturnType<typeof createMemoryStorage>;
  runtime: GoogleRuntime;
  transport: GmailTransport;
  setClock(value: string): void;
  step(): Promise<void>;
  scan(): Promise<M5aScanDocument>;
  marker(messageId: string): Promise<M5aMarker | null>;
  calls: { model: number; byMessage: Record<string, number>; fetches: number };
  /** Runs inside the paid call, before it answers. */
  hooks: { during?: (messageId: string) => Promise<void> };
}

/** The production-shaped path: a real quota permit and the real share adapter around a fake provider. */
async function harness(
  uid: string,
  ids: readonly string[],
  answer: (messageId: string, attempt: number) => 'fail' | 'ok',
  options: { page?: boolean } = {},
): Promise<Harness> {
  const storage = createMemoryStorage();
  let clock = NOW;
  const calls = { model: 0, byMessage: {} as Record<string, number>, fetches: 0 };
  const hooks: Harness['hooks'] = {};
  const messageOf = (request: LlmStructuredRequest): string => {
    const text = JSON.stringify(request);
    return ids.find(id => text.includes(`body-of-${id}.`)) ?? 'unknown';
  };
  const provider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { throw new Error('wrong provider verb'); },
    generateStructured: async request => {
      const id = messageOf(request);
      calls.model += 1;
      calls.byMessage[id] = (calls.byMessage[id] ?? 0) + 1;
      await hooks.during?.(id);
      if (answer(id, calls.byMessage[id]!) === 'fail') throw new Error('model answer cut off');
      return { text: JSON.stringify({ observations: [{ kind: 'commitment', evidence: `Please sign body-of-${id}.`, confidence: 0.95 }] }),
        model: 'fake-share', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
  };
  const runtime: GoogleRuntime = {
    storage, env: { MAYBESITTER_ENV: 'staging' } as GoogleRuntime['env'], secrets: null, fetchImpl: fetch,
    now: () => new Date(clock), shareProvider: provider, captureProvider: provider,
  };
  await storage.set(`users/${uid}`, { trust: { ...createPilotTrustState(uid, NOW), calendarConsent: true } });
  await storage.set('system/m5aControls', { email: { epoch: 3, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(scanPath(uid), {
    scanId: 'scan-1', kind: 'manual', status: 'running', origin: 'manual', providerAccountId: 'acct', emailEpoch: 3,
    query: 'after:1 before:9999999999', from: '2026-10-19T00:00:00.000Z', until: '2026-10-20T00:00:00.000Z',
    timezone: 'UTC', startedAt: NOW, finishedAt: null, failedAt: null, failure: null, pageToken: null,
    page: options.page === false ? null : { ids: [...ids], nextPageToken: null, done: [] },
    leaseOwner: null, leaseUntil: null, queued: null, nextEligibleAt: NOW, waiting: null,
    messagesRead: 0, messagesSkippedBulk: 0, messagesUnanalysed: 0, messagesUnavailable: 0, messagesTrimmed: 0,
    observationsFound: 0, addedFromEmail: 0,
  });
  const transport = {
    listRecentMessageIds: async () => ({ ids: [...ids], nextPageToken: null }),
    getMessageById: async (id: string) => {
      calls.fetches += 1;
      return { id, threadId: null, historyId: '101', receivedAt: '2026-10-19T09:00:00.000Z', from: null, subject: null,
        text: `Please sign body-of-${id}.`, sentByAccount: false, isReply: false, bodyFormat: 'text/plain' as const };
    },
  } as unknown as GmailTransport;
  return {
    storage, runtime, transport, calls, hooks,
    setClock: value => { clock = value; },
    step: () => runM5aScanStep(uid, 'manual', runtime, transport, async () => undefined),
    scan: async () => (await storage.get<M5aScanDocument>(scanPath(uid)))!,
    marker: messageId => storage.get<M5aMarker>(markerPath(uid, messageId)),
  };
}

test('#815 the backoff schedule is 2, 4, 8, 16 minutes, then capped at 30', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 12].map(n => m5aRetryBackoffMs(n) / MINUTE), [2, 4, 8, 16, 30, 30, 30]);
  assert.equal(M5A_MAX_ANALYSIS_ATTEMPTS, 3);
});

test('#815 a message whose analysis always fails stops after 3 model calls, is counted unanalysed, and the scan completes', async () => {
  const uid = 'stuck-always-fails';
  const h = await harness(uid, ['bad', 'good'], id => id === 'bad' ? 'fail' : 'ok');

  await h.step();
  let scan = await h.scan();
  assert.equal(h.calls.byMessage.bad, 1);
  assert.equal(scan.status, 'failed');
  assert.equal(scan.failure, 'analysis_unavailable');
  assert.equal(scan.nextEligibleAt, at(2), 'the first failure did not back off two minutes');
  assert.equal((await h.marker('bad'))?.state, 'released');
  assert.equal((await h.marker('bad'))?.analysisAttempts, 1);

  // The sweep runs every minute; inside the backoff it must not buy a call.
  h.setClock(at(1));
  await h.step();
  assert.equal(h.calls.byMessage.bad, 1, 'the failed scan was retried inside its backoff');

  h.setClock(at(2));
  await h.step();
  scan = await h.scan();
  assert.equal(h.calls.byMessage.bad, 2);
  assert.equal(scan.status, 'failed');
  assert.equal(scan.nextEligibleAt, at(2 + 4), 'the second failure did not back off four minutes');
  assert.equal((await h.marker('bad'))?.analysisAttempts, 2);

  h.setClock(at(5));
  await h.step();
  assert.equal(h.calls.byMessage.bad, 2, 'the failed scan was retried inside its grown backoff');

  h.setClock(at(6));
  await h.step();
  scan = await h.scan();
  assert.equal(h.calls.byMessage.bad, 3);
  assert.equal(scan.status, 'running', 'the third failure stalled the scan instead of moving on');
  assert.equal(scan.messagesRead, 1);
  assert.equal(scan.messagesUnanalysed, 1);
  assert.deepEqual(scan.page?.done, ['bad']);
  assert.equal(scan.consecutiveFailures, undefined, 'moving on did not reset the backoff');
  const marker = await h.marker('bad');
  assert.equal(marker?.state, 'done');
  assert.equal(marker?.outcome, 'unanalysed');
  assert.equal(marker?.analysisAttempts, 3);
  assert.deepEqual(marker?.observationIds, []);
  assert.equal(marker?.receipts?.['scan-1'], 'read');
  // The versioned bulk reclaim (outcome 'bulk' with an older rule) must never reopen it.
  assert.equal(markerDecision(marker, 'm5a', at(6)), 'count');

  for (let tick = 0; tick < 4; tick += 1) {
    h.setClock(at(7 + tick));
    await h.step();
  }
  scan = await h.scan();
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesRead, 2);
  assert.equal(scan.messagesUnanalysed, 1);
  assert.equal(scan.observationsFound, 1);
  assert.equal(h.calls.byMessage.bad, 3, 'the unanalysed message reached the model again');
  assert.equal(h.calls.model, 4, 'exactly 3 failed calls and 1 good call');

  // The new counter is announced only to clients that parse it (strict schemas).
  assert.equal(publicScanStatus(scan, true, true, true)?.messagesUnanalysed, 1);
  assert.equal('messagesUnanalysed' in publicScanStatus(scan, true, true)!, false);
});

test('#815 a failed scan backs off 2, 4, 8, 16, 30, 30 minutes, and progress resets it', async () => {
  const uid = 'stuck-gmail-down';
  const h = await harness(uid, ['mail'], () => 'ok');
  let gmailDown = true;
  const fetchOnce = h.transport.getMessageById.bind(h.transport);
  (h.transport as { getMessageById: GmailTransport['getMessageById'] }).getMessageById = async id => {
    if (gmailDown) { h.calls.fetches += 1; throw new GmailProviderError('gmail 500', 500); }
    return fetchOnce(id);
  };
  const gaps: number[] = [];
  let clock = Date.parse(NOW);
  for (let failure = 0; failure < 6; failure += 1) {
    const fetches = h.calls.fetches;
    await h.step();
    assert.equal(h.calls.fetches, fetches + 1);
    const scan = await h.scan();
    assert.equal(scan.status, 'failed');
    assert.equal(scan.failure, 'source_unavailable');
    const next = Date.parse(scan.nextEligibleAt);
    gaps.push((next - clock) / MINUTE);
    h.setClock(new Date(next - 1).toISOString());
    await h.step();
    assert.equal(h.calls.fetches, fetches + 1, 'a step ran before nextEligibleAt');
    clock = next;
    h.setClock(new Date(clock).toISOString());
  }
  assert.deepEqual(gaps, [2, 4, 8, 16, 30, 30]);

  gmailDown = false;
  await h.step();
  const scan = await h.scan();
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesRead, 1);
  assert.equal(scan.consecutiveFailures, undefined, 'success did not reset the backoff');
});

test('#815 daily-cap refusals are deferrals, never analysis attempts', async () => {
  const uid = 'stuck-daily-cap';
  const h = await harness(uid, ['mail'], () => 'ok');
  // Four days in a row the daily M5a budget is already spent when the scan resumes.
  for (let day = 0; day < 4; day += 1) {
    const date = new Date(Date.parse(NOW) + day * 24 * 60 * MINUTE);
    const key = date.toISOString().slice(0, 10);
    h.setClock(date.toISOString());
    await h.storage.set(`users/${uid}/usage/${key}`, {
      calls: 0, m5aCalls: M5A_USER_DAILY_CALL_CAP, date: key, updatedAt: date.toISOString(),
      inputTokens: 0, outputTokens: 0, reservedTokens: 0, m5aReservedTokens: 0,
    });
    await h.step();
    const scan = await h.scan();
    assert.equal(scan.status, 'failed');
    assert.equal(scan.failure, 'daily_limit');
    assert.equal(scan.consecutiveFailures, undefined, 'a daily-cap refusal grew the analysis backoff');
    assert.equal((await h.marker('mail'))?.analysisAttempts, undefined, 'a daily-cap refusal counted as an attempt');
  }
  assert.equal(h.calls.model, 0);

  h.setClock('2026-10-23T00:00:00.000Z');
  await h.step();
  const scan = await h.scan();
  assert.equal(h.calls.model, 1);
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesUnanalysed, 0);
  assert.equal((await h.marker('mail'))?.outcome, 'analyzed');
});

test('#815 a permit whose minute ends before dispatch defers to the next minute without counting', async () => {
  const uid = 'stuck-minute-boundary';
  const h = await harness(uid, ['mail'], () => 'ok');
  // Move the clock into the next minute right after the permit is reserved,
  // before the model is dispatched.
  const original = h.storage.runTransaction.bind(h.storage);
  let flipped = false;
  (h.storage as { runTransaction: typeof original }).runTransaction = (async (fn: Parameters<typeof original>[0]) => {
    const result = await original(fn);
    if (!flipped && ((await h.storage.get<{ m5aCalls?: number }>(`users/${uid}/usage/2026-10-19`))?.m5aCalls ?? 0) > 0) {
      flipped = true;
      h.setClock(at(1));
    }
    return result;
  }) as typeof original;
  await h.step();
  let scan = await h.scan();
  assert.ok(flipped);
  assert.equal(h.calls.model, 0);
  assert.equal(scan.status, 'running', 'a minute boundary failed the scan');
  assert.equal(scan.nextEligibleAt, at(2));
  assert.equal(scan.consecutiveFailures, undefined);
  assert.equal((await h.marker('mail'))?.state, 'released');
  assert.equal((await h.marker('mail'))?.analysisAttempts, undefined, 'a minute boundary counted as an attempt');

  h.setClock(at(2));
  await h.step();
  scan = await h.scan();
  assert.equal(h.calls.model, 1);
  assert.equal(scan.status, 'complete');
  assert.equal((await h.marker('mail'))?.outcome, 'analyzed');
});

test('#815 a transient failure that succeeds on the second attempt is analysed normally', async () => {
  const uid = 'stuck-transient';
  const h = await harness(uid, ['mail'], (_id, attempt) => attempt === 1 ? 'fail' : 'ok');
  await h.step();
  assert.equal((await h.scan()).status, 'failed');
  h.setClock(at(2));
  await h.step();
  const scan = await h.scan();
  assert.equal(h.calls.model, 2);
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesRead, 1);
  assert.equal(scan.messagesUnanalysed, 0);
  assert.equal(scan.observationsFound, 1);
  assert.equal(scan.consecutiveFailures, undefined);
  const marker = await h.marker('mail');
  assert.equal(marker?.outcome, 'analyzed');
  assert.equal(marker?.observationIds?.length, 1);
});

test('#815 a resume and a later scan count the unanalysed marker without fetching or calling the model', async () => {
  const uid = 'stuck-resume';
  const h = await harness(uid, ['bad', 'good'], id => id === 'bad' ? 'fail' : 'ok');
  for (const minute of [0, 2, 6, 7, 8]) { h.setClock(at(minute)); await h.step(); }
  let scan = await h.scan();
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesUnanalysed, 1);
  const { model, fetches } = { ...h.calls };

  // A crash/retry re-opens the same scan at the unanalysed id.
  await h.storage.set(scanPath(uid), {
    ...scan, status: 'failed', finishedAt: null, failedAt: at(8), failure: 'analysis_unavailable',
    page: { ids: ['bad'], nextPageToken: null, done: [] }, nextEligibleAt: at(8),
  });
  await h.step();
  scan = await h.scan();
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesRead, 2);
  assert.equal(scan.messagesUnanalysed, 1, 'a resume counted the unanalysed marker twice');

  // A later scan over the same mail counts the finished marker from the marker alone.
  await h.storage.set(scanPath(uid), {
    ...scan, scanId: 'scan-2', status: 'running', finishedAt: null, failedAt: null, failure: null,
    pageToken: null, page: null, nextEligibleAt: at(9),
    messagesRead: 0, messagesSkippedBulk: 0, messagesUnanalysed: 0, messagesUnavailable: 0, messagesTrimmed: 0,
    observationsFound: 0, addedFromEmail: 0,
  });
  for (let tick = 0; tick < 4; tick += 1) { h.setClock(at(9 + tick)); await h.step(); }
  scan = await h.scan();
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesRead, 2);
  assert.equal(scan.messagesUnanalysed, 1, 'a later scan did not count the unanalysed marker');
  assert.equal(h.calls.model, model, 'a finished message reached the model again');
  assert.equal(h.calls.fetches, fetches, 'a finished message was fetched again');
});

/** Steps through `ticks` failed ticks, each at the scan's own nextEligibleAt, returning the gaps in minutes. */
async function failingTicks(h: Harness, ticks: number): Promise<number[]> {
  const gaps: number[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    const before = await h.scan();
    h.setClock(before.nextEligibleAt);
    await h.step();
    const after = await h.scan();
    assert.equal(after.status, 'failed');
    gaps.push((Date.parse(after.nextEligibleAt) - Date.parse(before.nextEligibleAt)) / MINUTE);
  }
  return gaps;
}

test('#815 F1 with the AI kill switch on, a refused call is never an attempt, and the mail is analysed once it is off', async () => {
  const uid = 'stuck-kill-switch';
  const h = await harness(uid, ['mail'], () => 'ok');
  const previous = process.env.MAYBESITTER_AI_DISABLED;
  process.env.MAYBESITTER_AI_DISABLED = 'true';
  try {
    const gaps = await failingTicks(h, 5);
    const scan = await h.scan();
    assert.equal(h.calls.model, 0);
    assert.equal(scan.failure, 'analysis_unavailable');
    assert.deepEqual(gaps, [2, 4, 8, 16, 30], 'the refused scan did not back off');
    assert.equal(scan.messagesUnanalysed, 0);
    const marker = await h.marker('mail');
    assert.equal(marker?.analysisAttempts, undefined, 'a kill-switch refusal counted as an attempt');
    assert.notEqual(marker?.outcome, 'unanalysed');
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_AI_DISABLED; else process.env.MAYBESITTER_AI_DISABLED = previous;
  }
  h.setClock((await h.scan()).nextEligibleAt);
  await h.step();
  const scan = await h.scan();
  assert.equal(h.calls.model, 1);
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesUnanalysed, 0);
  assert.equal((await h.marker('mail'))?.outcome, 'analyzed');
});

test('#815 F1 a provider that refuses before sending (provider_none) is never an attempt', async () => {
  const uid = 'stuck-provider-none';
  const h = await harness(uid, ['mail'], () => 'ok');
  const mutable = h.runtime as { shareProvider?: LlmProvider };
  const real = mutable.shareProvider;
  mutable.shareProvider = {
    name: 'none',
    generateJson: async () => { throw new Error('must not dispatch'); },
    generateStructured: async () => { throw new Error('must not dispatch'); },
  } as LlmProvider;
  await failingTicks(h, 4);
  assert.equal(h.calls.model, 0);
  assert.equal((await h.marker('mail'))?.analysisAttempts, undefined, 'a provider_none refusal counted as an attempt');
  mutable.shareProvider = real;
  h.setClock((await h.scan()).nextEligibleAt);
  await h.step();
  assert.equal((await h.scan()).status, 'complete');
  assert.equal((await h.marker('mail'))?.outcome, 'analyzed');
});

test('#815 F2 the claim records the dispatch only after the free gates, right before the paid call', async () => {
  const uid = 'stuck-dispatch-mark';
  const h = await harness(uid, ['mail'], () => 'ok');
  let seen: M5aMarker | null = null;
  h.hooks.during = async () => { seen = await h.marker('mail'); };
  await h.step();
  assert.equal(seen!.state, 'claimed');
  assert.ok(seen!.dispatchOwner, 'the paid call started without recording its dispatch');
  assert.equal(seen!.dispatchOwner, seen!.owner);
  assert.equal((await h.scan()).status, 'complete');
});

test('#815 F2 an attempt is counted even when the scan fence moved during the paid call; the cap still holds', async () => {
  const uid = 'stuck-fence-moved';
  const h = await harness(uid, ['mail'], () => 'fail');
  // Two attempts were already spent by earlier ticks.
  await h.storage.set(markerPath(uid, 'mail'), { v: 2, state: 'released', providerAccountId: 'acct', analysisAttempts: 2 });
  let moved = false;
  h.hooks.during = async () => {
    if (moved) return;
    moved = true;
    await h.storage.set('system/m5aControls', { email: { epoch: 4, enabled: true }, calendar: { epoch: 1, enabled: true } });
  };
  await h.step();
  assert.equal(h.calls.model, 1);
  const marker = await h.marker('mail');
  assert.equal(marker?.state, 'released', 'a fence-moved failure finished the message without the fence');
  assert.equal(marker?.analysisAttempts, 3, 'a paid attempt was forgotten because the fence moved');

  // The switch comes back; the spent message is finished without a fourth call.
  await h.storage.set('system/m5aControls', { email: { epoch: 3, enabled: true }, calendar: { epoch: 1, enabled: true } });
  h.setClock((await h.scan()).nextEligibleAt);
  await h.step();
  const scan = await h.scan();
  assert.equal(h.calls.model, 1, 'the cap was exceeded after a fence move');
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesUnanalysed, 1);
  assert.equal((await h.marker('mail'))?.outcome, 'unanalysed');
});

test('#815 F2 taking over a claim that died after dispatch counts its attempt; one that died before dispatch does not', async () => {
  const expired = '2026-10-19T09:55:00.000Z';
  // Died after dispatch, with two attempts already counted: the takeover counts
  // the third and finishes the message without another call.
  const dead = await harness('stuck-takeover-dispatched', ['mail'], () => 'ok');
  await dead.storage.set(markerPath('stuck-takeover-dispatched', 'mail'), {
    v: 2, state: 'claimed', owner: 'dead-claim', leaseUntil: expired, providerAccountId: 'acct',
    dispatchOwner: 'dead-claim', analysisAttempts: 2,
  });
  await dead.step();
  let scan = await dead.scan();
  assert.equal(dead.calls.model, 0, 'a takeover past the cap bought another call');
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesUnanalysed, 1);
  assert.equal((await dead.marker('mail'))?.analysisAttempts, 3);

  // Died before dispatch: the takeover counts nothing and the mail is analysed.
  const early = await harness('stuck-takeover-early', ['mail'], () => 'ok');
  await early.storage.set(markerPath('stuck-takeover-early', 'mail'), {
    v: 2, state: 'claimed', owner: 'dead-claim', leaseUntil: expired, providerAccountId: 'acct', analysisAttempts: 2,
  });
  await early.step();
  scan = await early.scan();
  assert.equal(early.calls.model, 1);
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesUnanalysed, 0);
  const marker = await early.marker('mail');
  assert.equal(marker?.outcome, 'analyzed');
  assert.equal(marker?.analysisAttempts, 2, 'a takeover without a dispatch counted an attempt');
});

/** Runs `fn` once, right after the transaction that reserves the message's quota permit. */
function afterPermitReserved(h: Harness, uid: string, fn: () => Promise<void>): () => boolean {
  const original = h.storage.runTransaction.bind(h.storage);
  let fired = false;
  (h.storage as { runTransaction: typeof original }).runTransaction = (async (body: Parameters<typeof original>[0]) => {
    const result = await original(body);
    if (!fired && ((await h.storage.get<{ m5aCalls?: number }>(`users/${uid}/usage/2026-10-19`))?.m5aCalls ?? 0) > 0) {
      fired = true;
      await fn();
    }
    return result;
  }) as typeof original;
  return () => fired;
}

test('#815 R1 a claim stolen between claim and dispatch never sends the paid call and counts nothing', async () => {
  const uid = 'stuck-claim-stolen';
  const h = await harness(uid, ['mail'], () => 'ok');
  // Another unit (a live or daily scan sharing the marker id) takes the message
  // over after this unit claimed it and reserved its permit, before dispatch.
  const fired = afterPermitReserved(h, uid, async () => {
    const marker = await h.marker('mail');
    await h.storage.set(markerPath(uid, 'mail'), { ...marker, owner: 'other-unit', leaseUntil: at(10) });
  });
  await h.step();
  assert.ok(fired());
  assert.equal(h.calls.model, 0, 'the paid call went out under a lost claim');
  const marker = await h.marker('mail');
  assert.equal(marker?.owner, 'other-unit', 'the lost claim overwrote the new owner');
  assert.equal(marker?.analysisAttempts, undefined, 'a lost claim counted an attempt');
  assert.equal(marker?.dispatchOwner, undefined);
  assert.notEqual((await h.scan()).status, 'complete');
});

test('#815 R2 a minute that ends between the wrapper check and the adapter slot start defers without counting', async () => {
  const uid = 'stuck-slot-minute';
  const h = await harness(uid, ['mail'], () => 'ok');
  // After the permit is reserved, the wrapper's own minute check sees the old
  // minute; the adapter's slot start, the next clock read, sees the new one.
  const mutable = h.runtime as { now: () => Date };
  const base = mutable.now;
  let reads = -1;
  afterPermitReserved(h, uid, async () => { reads = 0; });
  mutable.now = () => {
    if (reads >= 0 && reads < 2) { reads += 1; if (reads === 2) h.setClock(at(1)); }
    return base();
  };
  await h.step();
  let scan = await h.scan();
  assert.equal(reads, 2, 'the clock did not move between the two checks');
  assert.equal(h.calls.model, 0);
  assert.equal((await h.marker('mail'))?.analysisAttempts, undefined, 'a refused slot start counted an attempt');
  assert.equal(scan.status, 'running', 'a slot-start minute boundary failed the scan');
  assert.equal(scan.nextEligibleAt, at(2));

  h.setClock(at(2));
  await h.step();
  scan = await h.scan();
  assert.equal(h.calls.model, 1);
  assert.equal(scan.status, 'complete');
  assert.equal((await h.marker('mail'))?.outcome, 'analyzed');
});
