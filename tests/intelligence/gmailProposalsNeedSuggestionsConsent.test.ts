/**
 * «وقّف الاقتراحات والتعلّم» stops the Gmail proposal model call too
 * (review of #873, V3-F35-07).
 *
 * Stopping declines the next-step suggestions consent, and the screens hide
 * suggestions under it. The Gmail monitor's proposal step did not read that
 * consent at all: with monitoring on, the background job kept sending the
 * person's mail observations to the model, spending their budget and storing
 * hidden suggestions that surfaced the moment they turned suggestions back
 * on. Monitoring itself (reading and watching) keeps its own switch; only the
 * step that asks the model for suggestions waits for this consent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_CONNECTIONS, createMemoryStorage, userCol, userSubDoc } from '../../lib/storage';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime';
import { GOOGLE_FEATURE_SCOPES } from '../../lib/integrations/google/googleConfig';
import { connectionIdFor } from '../../lib/integrations/providers/production/storedConnectionStore';
import { runGmailJobTick } from '../../lib/intelligence/gmailJobs';
import { putObservations } from '../../lib/intelligence/observationStore';
import type { LlmProvider } from '../../src/extraction/llm/llmProvider';
import { createPilotTrustState } from '../../lib/pilot/closedPilotControls.ts';
import { RECOMMENDATION_CONSENT_VERSION, setRecommendationConsent } from '../../lib/consents/recommendationConsentService';

const NOW = '2026-10-19T10:00:00.000Z';

async function monitoredAccount(uid: string, suggestions: 'granted' | 'declined' | 'never') {
  const storage = createMemoryStorage();
  await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: NOW }, trust: createPilotTrustState(uid, NOW) });
  if (suggestions !== 'never') {
    await setRecommendationConsent(uid, { state: suggestions, version: RECOMMENDATION_CONSENT_VERSION, at: new Date(NOW) }, { storage });
  }
  const [observation] = await putObservations(uid, 'manual', 'note', NOW, [{
    kind: 'request', evidence: 'Please send the form', confidence: 0.9,
  }], storage);
  await storage.set('system/m5aControls', { email: { epoch: 7, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(`users/${uid}/intelligenceMonitors/gmail`, {
    enabled: true, generation: 'g1', cursor: '100', pageToken: null, nextPollAt: '2026-10-20T00:00:00.000Z',
    lease: null, leaseUntil: null, lastSuccessAt: null, error: null,
    proposalsVersion: 1, proposalsDoneVersion: 0, proposalsPending: true, proposalNextEligibleAt: NOW,
    m5: { v: 1, providerAccountId: 'acct', enabledAt: NOW, timezone: 'UTC', at: NOW,
      pauseEpoch: 0, pausedSince: null, excluded: [] },
  });
  const calls = { model: 0 };
  const provider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { throw new Error('wrong provider verb'); },
    generateStructured: async () => {
      calls.model += 1;
      return { text: JSON.stringify({ suggestions: [{
        kind: 'action', title: 'Send the form', reason: 'The form was requested',
        observationIds: [observation!.id], confidence: 0.9, durationMinutes: 10,
      }] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
  };
  const runtime: GoogleRuntime = { storage,
    env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_EMAIL_SOURCES: 'true' } as GoogleRuntime['env'], secrets: null, fetchImpl: fetch,
    now: () => new Date(NOW), shareProvider: provider,
  };
  return { storage, runtime, calls };
}

for (const state of ['declined', 'never'] as const) {
  test(`suggestions ${state === 'never' ? 'never agreed to' : 'stopped'}: no model call, no budget, no stored suggestion, the turn waits`, async () => {
    const uid = `proposal-stopped-${state}`;
    const { storage, runtime, calls } = await monitoredAccount(uid, state);
    await runGmailJobTick('live', { runtime, ensureReadable: async () => undefined });
    assert.equal(calls.model, 0, 'the model was asked for suggestions the person stopped');
    assert.equal((await storage.list(userCol(uid, 'intelligenceSuggestions'))).length, 0, 'a hidden suggestion was stored');
    const monitor = await storage.get<any>(`users/${uid}/intelligenceMonitors/gmail`);
    assert.equal(monitor.proposalsPending, true, 'the pending work was dropped instead of waiting');
    assert.equal(monitor.proposalsDoneVersion, 0);
    assert.ok(Date.parse(monitor.proposalNextEligibleAt) > Date.parse(NOW), 'the turn was not deferred');
    assert.equal(monitor.enabled, true, 'stopping suggestions switched Gmail monitoring off');
  });
}

test('suggestions on: the proposal step runs as before', async () => {
  const uid = 'proposal-granted';
  const { storage, runtime, calls } = await monitoredAccount(uid, 'granted');
  await runGmailJobTick('live', { runtime, ensureReadable: async () => undefined });
  assert.ok(calls.model > 0);
  const monitor = await storage.get<any>(`users/${uid}/intelligenceMonitors/gmail`);
  assert.equal(monitor.proposalsDoneVersion, 1);
  assert.equal(monitor.proposalsPending, false);
});
