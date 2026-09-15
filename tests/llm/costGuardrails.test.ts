/**
 * What stops a model call from costing more than it should (UC-4.5, #181).
 *
 * These extend UC-2.0 (#160)'s guard rather than replacing it. There is one
 * quota subsystem and one set of counters; a second would mean two answers to
 * "how much has this account spent today" and no way to tell which was right.
 *
 * The three limits are three different failure modes:
 *
 *   daily calls   a slow leak, or a person using the product very heavily
 *   daily tokens  sixty calls of twenty thousand characters, which a call cap
 *                 cannot see
 *   per minute    a client in a tight retry loop, which can spend the whole day
 *                 in under a minute
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import {
  aiDisabled,
  callsToday,
  commitUsage,
  DEFAULT_GLOBAL_DAILY_CAP,
  DEFAULT_USER_DAILY_CAP,
  DEFAULT_USER_DAILY_TOKEN_CAP,
  DEFAULT_USER_MINUTE_CAP,
  MAX_INPUT_CHARACTERS,
  quotaScopeFor,
  reserveCall,
  retryAfterSecondsFor,
  USAGE_TTL_DAYS,
  utcMinute,
  type UsageDay,
} from '../../lib/llm/usageGuard.ts';
import { captureLlmProvider } from '../../lib/llm/captureProvider.ts';
import { LLMUnavailableError } from '../../src/extraction/llm/llmProvider.ts';

const UID = 'user-cost-guardrails';
const storage = () => createMemoryStorage();
const at = (iso: string) => new Date(iso);

test('the launch caps are the ones #181 decided', () => {
  assert.equal(DEFAULT_USER_DAILY_CAP, 60);
  assert.equal(DEFAULT_USER_DAILY_TOKEN_CAP, 150_000);
  assert.equal(DEFAULT_USER_MINUTE_CAP, 8);
  assert.equal(DEFAULT_GLOBAL_DAILY_CAP, 3_000);
  assert.equal(MAX_INPUT_CHARACTERS, 20_000);
});

test('a client in a retry loop is stopped within the minute, not at the daily cap', async () => {
  const store = storage();
  const now = at('2026-09-12T10:00:30.000Z');

  for (let call = 0; call < DEFAULT_USER_MINUTE_CAP; call += 1) {
    assert.equal(await reserveCall(UID, 'capture_extraction', { storage: store, now }), 'ok', `call ${call + 1}`);
  }
  assert.equal(await reserveCall(UID, 'capture_extraction', { storage: store, now }), 'user_minute_cap');

  // The daily budget is barely touched: this is the point of the limit. Eight of
  // sixty spent, not sixty.
  assert.equal((await callsToday(UID, { storage: store, now })).user, DEFAULT_USER_MINUTE_CAP);
});

test('the minute window clears on its own', async () => {
  const store = storage();
  for (let call = 0; call < DEFAULT_USER_MINUTE_CAP; call += 1) {
    await reserveCall(UID, 'capture_extraction', { storage: store, now: at('2026-09-12T10:00:30.000Z') });
  }
  assert.equal(
    await reserveCall(UID, 'capture_extraction', { storage: store, now: at('2026-09-12T10:00:59.000Z') }),
    'user_minute_cap',
    'still the same minute',
  );
  assert.equal(
    await reserveCall(UID, 'capture_extraction', { storage: store, now: at('2026-09-12T10:01:00.000Z') }),
    'ok',
    'a new minute starts a new window',
  );
});

test('the minute counter belongs to one minute, and is not carried into the next', async () => {
  const store = storage();
  await reserveCall(UID, 'capture_extraction', { storage: store, now: at('2026-09-12T10:00:30.000Z') });

  const later = at('2026-09-12T10:05:00.000Z');
  // Zero rather than one: a count from five minutes ago is not this minute's.
  assert.equal((await callsToday(UID, { storage: store, now: later })).minuteCalls, 0);
  // And the day's total is untouched by the window resetting.
  assert.equal((await callsToday(UID, { storage: store, now: later })).user, 1);
});

test('tokens are committed after the call, and cap the day once spent', async () => {
  const store = storage();
  const now = at('2026-09-12T10:00:00.000Z');

  await reserveCall(UID, 'capture_extraction', { storage: store, now });
  await commitUsage(UID, { promptTokens: 100_000, outputTokens: 60_000 }, { storage: store, now });

  assert.equal((await callsToday(UID, { storage: store, now })).tokens, 160_000);
  // Over the token cap, and under both the call and minute caps — so only the
  // token limit can have refused this.
  assert.equal(
    await reserveCall(UID, 'capture_extraction', { storage: store, now: at('2026-09-12T10:02:00.000Z') }),
    'user_token_cap',
  );
});

test('a reservation never erases the tokens already spent today', async () => {
  // The reservation and the commit write the same document. If the reservation
  // reset the counters, every call would clear the day's token total and the cap
  // would never bite.
  const store = storage();
  const now = at('2026-09-12T10:00:00.000Z');

  await reserveCall(UID, 'capture_extraction', { storage: store, now });
  await commitUsage(UID, { promptTokens: 1_000, outputTokens: 500 }, { storage: store, now });
  await reserveCall(UID, 'capture_extraction', { storage: store, now: at('2026-09-12T10:01:00.000Z') });

  const after = await callsToday(UID, { storage: store, now: at('2026-09-12T10:01:00.000Z') });
  assert.equal(after.tokens, 1_500, 'the reservation wiped the token counters');
  assert.equal(after.user, 2);
});

test('a commit with nothing in it writes nothing', async () => {
  const store = storage();
  const now = at('2026-09-12T10:00:00.000Z');
  await commitUsage(UID, { promptTokens: 0, outputTokens: 0 }, { storage: store, now });
  assert.equal((await callsToday(UID, { storage: store, now })).tokens, 0);
});

test('every usage document carries a TTL, so the counters do not accumulate forever', async () => {
  const store = storage();
  const now = at('2026-09-12T10:00:00.000Z');
  await reserveCall(UID, 'capture_extraction', { storage: store, now });

  const day = await store.get<UsageDay>(`users/${UID}/usage/2026-09-12`);
  assert.ok(day?.expireAt, 'no expireAt, so the Firestore TTL policy has nothing to act on');
  const days = (Date.parse(day!.expireAt!) - now.getTime()) / 86_400_000;
  assert.equal(Math.round(days), USAGE_TTL_DAYS);

  const global = await store.get<UsageDay>('llmUsage/2026-09-12');
  assert.ok(global?.expireAt, 'the global counter is kept forever');
});

test('the scope a user is told is coarser than the counter that refused them', () => {
  // Somebody learns that they are over a limit, or that the service is. Never
  // which internal counter said so.
  assert.equal(quotaScopeFor('user_cap'), 'user_daily');
  assert.equal(quotaScopeFor('user_token_cap'), 'user_daily');
  assert.equal(quotaScopeFor('user_minute_cap'), 'user_minute');
  assert.equal(quotaScopeFor('global_cap'), 'global_daily');
  // Not a quota problem, and must not be reported as one: an unreadable counter
  // is an outage, and telling the user they are over budget would be a lie.
  assert.equal(quotaScopeFor('unavailable'), null);
  assert.equal(quotaScopeFor('ok'), null);
});

test('retry-after is the truth about when the limit clears', () => {
  // A minute cap clears inside the minute.
  assert.equal(retryAfterSecondsFor('user_minute', at('2026-09-12T10:00:30.000Z')), 30);
  assert.equal(retryAfterSecondsFor('user_minute', at('2026-09-12T10:00:59.000Z')), 1);
  // A daily cap clears at the next UTC midnight, which is not a fixed number of
  // seconds — saying "3600" would be wrong for most of the day.
  assert.equal(retryAfterSecondsFor('user_daily', at('2026-09-12T23:00:00.000Z')), 3_600);
  assert.equal(retryAfterSecondsFor('global_daily', at('2026-09-12T00:00:00.000Z')), 86_400);
});

test('utcMinute is the window key, to the minute', () => {
  assert.equal(utcMinute(at('2026-09-12T10:00:30.000Z')), '2026-09-12T10:00');
  assert.equal(utcMinute(at('2026-09-12T10:00:59.999Z')), '2026-09-12T10:00');
  assert.equal(utcMinute(at('2026-09-12T10:01:00.000Z')), '2026-09-12T10:01');
});

/** A provider that records whether it was reached at all. */
function spyProvider() {
  const calls: string[] = [];
  const answer = async () => {
    calls.push('generateJson');
    return { text: '{}', model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 10, outputTokens: 5 };
  };
  return {
    calls,
    provider: {
      name: 'gemini' as const,
      generateJson: answer,
      // Required since #183. This double answers the same way either way, so
      // the spy counts a call however it was made.
      generateStructured: answer,
    },
  };
}

test('the kill switch takes every call out of the product without a deploy', async () => {
  const previous = process.env.MAYBESITTER_AI_DISABLED;
  try {
    process.env.MAYBESITTER_AI_DISABLED = 'true';
    assert.equal(aiDisabled(), true);

    const spy = spyProvider();
    const provider = captureLlmProvider(UID, {
      provider: spy.provider,
      consent: async () => 'granted',
      reserve: async () => 'ok',
    });

    await assert.rejects(() => provider('anything'), (error: unknown) => {
      assert.ok(error instanceof LLMUnavailableError);
      assert.equal((error as LLMUnavailableError).reason, 'ai_disabled');
      return true;
    });
    // Not reached, and not reserved either: the switch is in front of both.
    assert.deepEqual(spy.calls, []);
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_AI_DISABLED;
    else process.env.MAYBESITTER_AI_DISABLED = previous;
  }
});

test('the kill switch is off unless it is explicitly on', () => {
  const previous = process.env.MAYBESITTER_AI_DISABLED;
  try {
    for (const value of ['', 'false', '0', 'no', 'nope', undefined]) {
      if (value === undefined) delete process.env.MAYBESITTER_AI_DISABLED;
      else process.env.MAYBESITTER_AI_DISABLED = value;
      assert.equal(aiDisabled(), false, `"${value}" disabled the model`);
    }
    for (const value of ['true', 'TRUE', '1', 'yes', ' true ']) {
      process.env.MAYBESITTER_AI_DISABLED = value;
      assert.equal(aiDisabled(), true, `"${value}" did not disable the model`);
    }
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_AI_DISABLED;
    else process.env.MAYBESITTER_AI_DISABLED = previous;
  }
});

test('an oversized input is refused before it is reserved or sent', async () => {
  const spy = spyProvider();
  let reserved = 0;
  const provider = captureLlmProvider(UID, {
    provider: spy.provider,
    consent: async () => 'granted',
    reserve: async () => { reserved += 1; return 'ok'; },
  });

  await assert.rejects(
    () => provider('x'.repeat(MAX_INPUT_CHARACTERS + 1)),
    (error: unknown) => {
      assert.equal((error as LLMUnavailableError).reason, 'input_too_large');
      return true;
    },
  );
  assert.deepEqual(spy.calls, [], 'the oversized prompt reached the provider');
  assert.equal(reserved, 0, 'the oversized prompt spent a reservation');
});

test('an input exactly at the limit is allowed', async () => {
  const spy = spyProvider();
  const provider = captureLlmProvider(UID, {
    provider: spy.provider,
    consent: async () => 'granted',
    reserve: async () => 'ok',
    commit: async () => {},
  });

  await provider('x'.repeat(MAX_INPUT_CHARACTERS));
  assert.deepEqual(spy.calls, ['generateJson']);
});

test('what the call cost is committed from the provider’s own counts', async () => {
  const committed: Array<{ promptTokens?: number; outputTokens?: number }> = [];
  const spy = spyProvider();
  const provider = captureLlmProvider(UID, {
    provider: spy.provider,
    consent: async () => 'granted',
    reserve: async () => 'ok',
    commit: async (_uid, tokens) => { committed.push(tokens); },
  });

  await provider('a short prompt');
  assert.deepEqual(committed, [{ promptTokens: 10, outputTokens: 5 }]);
});

test('a refused call commits nothing, because it cost nothing', async () => {
  const committed: unknown[] = [];
  const spy = spyProvider();
  const provider = captureLlmProvider(UID, {
    provider: spy.provider,
    consent: async () => 'granted',
    reserve: async () => 'user_minute_cap',
    commit: async (_uid, tokens) => { committed.push(tokens); },
  });

  await assert.rejects(() => provider('anything'));
  assert.deepEqual(committed, []);
  assert.deepEqual(spy.calls, []);
});
