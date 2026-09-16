/**
 * "Notice patterns in when you finish things" (UC-3.16, #202).
 *
 * The third mobile consent, and the only one that gates a conclusion drawn
 * *about* the person. What these cases hold:
 *
 *  - it is off until this question is answered, whatever else the account has
 *    agreed to — an existing account with AI processing and next-step
 *    suggestions on gets no suggestions and no plan hint;
 *  - answering it writes both records the product reads, and growth needs both,
 *    so neither the frozen web store alone nor the versioned answer alone turns
 *    it on;
 *  - withdrawing it stops the suggestions *and* stops a kept pattern reaching
 *    the plan, which is what the toggle's own words promise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import {
  AI_CONSENT_VERSION,
  PERSONALIZATION_CONSENT,
  PERSONALIZATION_CONSENT_CLAIMS_V1,
  PERSONALIZATION_CONSENT_VERSION,
  RECOMMENDATION_CONSENT_VERSION,
  aiConsentClaimsDigest,
} from '../../src/contracts/v1/consentContracts.ts';
import { getConsent } from '../../lib/consents/consentService.ts';
import { setAiConsent } from '../../lib/consents/aiConsentService.ts';
import { setRecommendationConsent } from '../../lib/consents/recommendationConsentService.ts';
import {
  personalizationGrowthAllowed,
  setPersonalizationConsent,
} from '../../lib/consents/personalizationConsentService.ts';
import { createStoragePersonalizationConsentStore } from '../../lib/personalizationControls/consentStore.ts';
import { listAuditEvents } from '../../lib/pilot/pilotTrustStore.ts';
import { GET as consentsGet } from '../../src/app/api/mobile/consents/route.ts';
import { PUT as personalizationPut } from '../../src/app/api/mobile/consents/personalization/route.ts';
import { GET as memoryGet } from '../../src/app/api/mobile/memory/route.ts';
import { POST as suggestionPost } from '../../src/app/api/mobile/memory/suggestions/[ruleId]/route.ts';
import { keptFocusWindow } from '../../lib/memoryGrowth/suggestionService.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { EVENTS, userDoc, userSubDoc } from '../../lib/storage/paths.ts';

const BASE = 'http://127.0.0.1:4321';
const ZONE = 'Asia/Jerusalem';
const NOW_MS = Date.now();
const NOW = new Date(NOW_MS).toISOString();

let auth: FakeAuthControls | null = null;
let previousFlag: string | undefined;

function begin(): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  previousFlag = process.env.MAYBESITTER_FEATURE_MEMORY;
  process.env.MAYBESITTER_FEATURE_MEMORY = 'true';
}

function end(): void {
  if (previousFlag === undefined) delete process.env.MAYBESITTER_FEATURE_MEMORY;
  else process.env.MAYBESITTER_FEATURE_MEMORY = previousFlag;
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function request(uid: string | null, path: string, options: { body?: unknown; method?: string } = {}): Request {
  const headers = new Headers();
  if (uid) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'PUT'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

/** Ten things finished, seven of them between 09:00 and 12:00 local. */
async function seedHabit(uid: string): Promise<void> {
  const at = (daysAgo: number, hour: number, minute: number): string => {
    const base = new Date(NOW_MS - daysAgo * 86_400_000);
    for (let shift = -14; shift <= 14; shift += 1) {
      const candidate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour - shift, minute));
      const shown = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(candidate).find((part) => part.type === 'hour')!.value;
      if (Number(shown) === hour && candidate.getTime() < NOW_MS) return candidate.toISOString();
    }
    throw new Error('no instant');
  };
  await getStorage().set(userDoc(uid), { uid, timezone: ZONE });
  const times: Array<[number, number, number]> = [
    [1, 9, 15], [2, 9, 40], [3, 10, 0], [5, 10, 30], [6, 11, 0], [8, 11, 20], [9, 11, 45],
    [4, 19, 5], [7, 20, 5], [10, 21, 5],
  ];
  for (let index = 0; index < times.length; index += 1) {
    const [daysAgo, hour, minute] = times[index]!;
    const id = `ev_c${index}`;
    await getStorage().set(userSubDoc(uid, EVENTS, id), {
      id, type: 'commitment_completed', at: at(daysAgo, hour, minute), aggregateId: `c_${index}`, payload: {},
    });
  }
}

async function suggestionsFor(uid: string): Promise<unknown[]> {
  return (await json(await memoryGet(request(uid, '/api/mobile/memory')))).suggestions as unknown[];
}

async function answer(uid: string, state: 'granted' | 'declined', version = PERSONALIZATION_CONSENT_VERSION) {
  return personalizationPut(request(uid, '/api/mobile/consents/personalization', {
    method: 'PUT',
    body: { state, version, locale: 'ar', platform: 'ios' },
  }));
}

// ── The words ────────────────────────────────────────────────────

test('the personalization consent version is pinned to the claims it makes', () => {
  // Editing the claims without bumping the version would hold somebody to an
  // answer they gave to different words. Bump both, or neither.
  assert.equal(aiConsentClaimsDigest(PERSONALIZATION_CONSENT_CLAIMS_V1), '17661d8bbfd49dfc');
  assert.equal(PERSONALIZATION_CONSENT_VERSION, 'personalization-consent-v1');
  // The two promises the council's copy must keep: nothing is saved without a
  // Keep, and turning it off stops the plan using what was kept.
  assert.ok(PERSONALIZATION_CONSENT_CLAIMS_V1.some((claim) => claim.startsWith('what_is_saved:nothing_unless_you_keep_it')));
  assert.ok(PERSONALIZATION_CONSENT_CLAIMS_V1.some((claim) => claim.includes('plans_stop_using_patterns_you_kept')));
});

// ── Off by default, and never inferred from another answer ───────

test('a new account has not been asked, and growth is off', async () => {
  begin();
  try {
    const uid = uidFor('PersonalizationFresh');
    await seedHabit(uid);
    const view = await json(await consentsGet(request(uid, '/api/mobile/consents')));
    assert.equal(view.personalization.state, 'declined');
    assert.equal(view.personalization.asked, false);
    assert.equal(view.currentVersions.personalization, PERSONALIZATION_CONSENT_VERSION);
    assert.equal(await personalizationGrowthAllowed(uid), false);
    assert.deepEqual(await suggestionsFor(uid), []);
  } finally {
    end();
  }
});

test('an existing account with AI processing and next-step suggestions on is still off', async () => {
  begin();
  try {
    const uid = uidFor('PersonalizationExisting');
    await seedHabit(uid);
    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });
    await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });

    const view = await json(await consentsGet(request(uid, '/api/mobile/consents')));
    assert.equal(view.aiProcessing.state, 'granted');
    assert.equal(view.recommendations.state, 'granted');
    assert.equal(view.personalization.state, 'declined');
    assert.equal(view.personalization.asked, false, 'an older account must be asked, not assumed');

    assert.equal(await personalizationGrowthAllowed(uid), false);
    assert.deepEqual(await suggestionsFor(uid), [], 'another consent turned this one on');
  } finally {
    end();
  }
});

test('neither record alone turns growth on', async () => {
  begin();
  try {
    // The frozen web control centre writes the store and nothing else. That is
    // not an answer to the words this toggle shows, so it is not consent here.
    const web = uidFor('PersonalizationWebOnly');
    await seedHabit(web);
    await createStoragePersonalizationConsentStore().write(web, 'enabled', NOW);
    assert.equal(await personalizationGrowthAllowed(web), false);
    assert.deepEqual(await suggestionsFor(web), []);

    // And the versioned answer with the store disabled — the state a withdrawal
    // that failed half way would leave — is off too.
    const half = uidFor('PersonalizationHalf');
    await seedHabit(half);
    await answer(half, 'granted');
    await createStoragePersonalizationConsentStore().write(half, 'disabled', NOW);
    assert.equal(await personalizationGrowthAllowed(half), false);
    assert.deepEqual(await suggestionsFor(half), []);
  } finally {
    end();
  }
});

test('an answer to words this server no longer shows is not consent', async () => {
  begin();
  try {
    const uid = uidFor('PersonalizationOldWords');
    await seedHabit(uid);
    await answer(uid, 'granted');
    assert.equal(await personalizationGrowthAllowed(uid), true);

    // The record is rewritten as one written against a version this build does
    // not recognise, which `consentService` reads as declined.
    const path = userDoc(uid);
    const user = await getStorage().get<{ consents: Record<string, { version: string }> }>(path);
    user!.consents.personalization!.version = 'personalization-consent-v0';
    await getStorage().set(path, user);

    assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid), 'declined');
    assert.equal(await personalizationGrowthAllowed(uid), false);
    assert.deepEqual(await suggestionsFor(uid), []);
  } finally {
    end();
  }
});

// ── The route ────────────────────────────────────────────────────

test('turning it on makes suggestions appear, and turning it off stops them and the plan hint', async () => {
  begin();
  try {
    const uid = uidFor('PersonalizationToggle');
    await seedHabit(uid);
    assert.deepEqual(await suggestionsFor(uid), []);

    const on = await answer(uid, 'granted');
    assert.equal(on.status, 200);
    assert.equal((await json(on)).personalization.state, 'granted');
    assert.equal((await json(await consentsGet(request(uid, '/api/mobile/consents')))).personalization.asked, true);

    const suggestions = await suggestionsFor(uid);
    assert.equal(suggestions.length, 1);

    // Kept while it was on, so there is something for the withdrawal to stop.
    const kept = await suggestionPost(
      request(uid, '/api/mobile/memory/suggestions/R1_focus_window', {
        method: 'POST',
        body: { decision: 'keep', fingerprint: 'R1_focus_window:09:00-12:00', language: 'en' },
      }),
      { params: Promise.resolve({ ruleId: 'R1_focus_window' }) },
    );
    assert.equal(kept.status, 201);
    assert.deepEqual(await keptFocusWindow(uid, NOW), { start: '09:00', end: '12:00' });

    const off = await answer(uid, 'declined');
    assert.equal(off.status, 200);
    assert.equal((await json(off)).personalization.state, 'declined');

    assert.deepEqual(await suggestionsFor(uid), [], 'suggestions survived the withdrawal');
    assert.equal(await keptFocusWindow(uid, NOW), null, 'the plan would still use a kept pattern');
    // And the record itself is still the user's, listed and deletable: this
    // toggle stops the use, it does not erase what they chose to keep.
    const listed = (await json(await memoryGet(request(uid, '/api/mobile/memory')))).items as Array<{ id: string }>;
    assert.equal(listed.length, 1);
    assert.ok(await createStorageRuntimeMemoryStore().get(listed[0]!.id));

    // Keeping anything new is refused while it is off.
    const refused = await suggestionPost(
      request(uid, '/api/mobile/memory/suggestions/R1_focus_window', {
        method: 'POST',
        body: { decision: 'keep', fingerprint: 'R1_focus_window:09:00-12:00', language: 'en' },
      }),
      { params: Promise.resolve({ ruleId: 'R1_focus_window' }) },
    );
    assert.equal(refused.status, 403);
    assert.equal((await json(refused)).reason, 'personalization_consent_required');
  } finally {
    end();
  }
});

test('both records move together, and a withdrawal disables the store before it is recorded', async () => {
  begin();
  try {
    const uid = uidFor('PersonalizationMirror');
    await answer(uid, 'granted');
    assert.equal((await createStoragePersonalizationConsentStore().read(uid)).state, 'enabled');
    assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid), 'granted');

    await answer(uid, 'declined');
    assert.equal((await createStoragePersonalizationConsentStore().read(uid)).state, 'disabled');
    assert.equal(await getConsent(PERSONALIZATION_CONSENT, uid), 'declined');
  } finally {
    end();
  }
});

test('a refused answer changes nothing, and the caller is always the token', async () => {
  begin();
  try {
    const uid = uidFor('PersonalizationRefusals');
    await answer(uid, 'granted');

    for (const body of [
      { state: 'maybe', version: PERSONALIZATION_CONSENT_VERSION },
      { state: 'declined', version: 'personalization-consent-v99' },
      { state: 'declined' },
    ]) {
      const response = await personalizationPut(request(uid, '/api/mobile/consents/personalization', { method: 'PUT', body }));
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    // Still on: no refusal disabled anything on its way to being refused.
    assert.equal(await personalizationGrowthAllowed(uid), true);
    assert.equal((await createStoragePersonalizationConsentStore().read(uid)).state, 'enabled');

    const anonymous = await personalizationPut(request(null, '/api/mobile/consents/personalization', {
      method: 'PUT', body: { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION },
    }));
    assert.equal(anonymous.status, 401);

    // A uid in the body is not read: the answer belongs to the token's account.
    const other = uidFor('PersonalizationBystander');
    await personalizationPut(request(uid, '/api/mobile/consents/personalization', {
      method: 'PUT', body: { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, uid: other },
    }));
    assert.equal(await personalizationGrowthAllowed(other), false);
    assert.equal(await getConsent(PERSONALIZATION_CONSENT, other), 'declined');
    assert.equal(await personalizationGrowthAllowed(uid), false, 'the caller’s own answer was not recorded');
  } finally {
    end();
  }
});

test('every change is audited, with the question named and no free text', async () => {
  begin();
  try {
    const uid = uidFor('PersonalizationAudit');
    await answer(uid, 'granted');
    await answer(uid, 'declined');
    const codes = (await listAuditEvents(uid))
      .filter((event) => event.eventType === 'consent_changed')
      .map((event) => event.reasonCode);
    assert.deepEqual(codes, ['personalization_granted', 'personalization_declined']);
  } finally {
    end();
  }
});

test('the answer is the account’s own, and nobody else’s account is touched', async () => {
  begin();
  try {
    const mine = uidFor('PersonalizationMine');
    const theirs = uidFor('PersonalizationTheirs');
    await seedHabit(theirs);
    await answer(mine, 'granted');
    assert.equal(await personalizationGrowthAllowed(theirs), false);
    assert.deepEqual(await suggestionsFor(theirs), []);
  } finally {
    end();
  }
});
