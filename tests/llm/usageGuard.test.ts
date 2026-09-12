/**
 * What a day of model calls is allowed to cost (UC-2.0, #160).
 *
 * The budget is a ₪100/month alert that stops nothing, so the cap has to. Two
 * things can empty it — one account in a loop, and everybody at once — so
 * there are two counters, and both move in the same transaction.
 *
 * The Firestore half of this is `tests/storage/llmUsageGuard.emulator.test.ts`:
 * a counter is only a cap if concurrent instances cannot both read the same
 * number, and the memory adapter cannot prove that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import {
  DEFAULT_GLOBAL_DAILY_CAP,
  DEFAULT_USER_DAILY_CAP,
  callsToday,
  reserveCall,
  utcDay,
} from '../../lib/llm/usageGuard.ts';

const UID = 'user_cost_guard';
const OTHER = 'user_cost_guard_other';

function storage(): StorageAdapter {
  return createMemoryStorage();
}

test('a call is reserved, and the reservation is what the counter counts', async () => {
  const store = storage();
  const now = new Date('2026-09-12T10:00:00.000Z');

  assert.equal(await reserveCall(UID, 'capture_extraction', { storage: store, now }), 'ok');
  assert.deepEqual(await callsToday(UID, { storage: store, now }), { user: 1, global: 1 });

  await reserveCall(UID, 'capture_extraction', { storage: store, now });
  assert.deepEqual(await callsToday(UID, { storage: store, now }), { user: 2, global: 2 });
});

test('the call over the user cap is refused, and it is the 151st', async () => {
  // #160's acceptance criterion, stated as the number it names.
  const store = storage();
  const now = new Date('2026-09-12T10:00:00.000Z');
  const userCap = DEFAULT_USER_DAILY_CAP;

  for (let call = 0; call < userCap; call += 1) {
    const outcome = await reserveCall(UID, 'capture_extraction', { storage: store, now });
    assert.equal(outcome, 'ok', `call ${call + 1} was refused before the cap`);
  }
  assert.equal(await reserveCall(UID, 'capture_extraction', { storage: store, now }), 'user_cap');
  assert.equal((await callsToday(UID, { storage: store, now })).user, userCap, 'a refused call was still counted');
});

test('one account over its cap does not stop another account', async () => {
  const store = storage();
  const now = new Date('2026-09-12T10:00:00.000Z');
  for (let call = 0; call < 3; call += 1) {
    await reserveCall(UID, 'capture_extraction', { storage: store, now, userCap: 3 });
  }

  assert.equal(await reserveCall(UID, 'capture_extraction', { storage: store, now, userCap: 3 }), 'user_cap');
  assert.equal(await reserveCall(OTHER, 'capture_extraction', { storage: store, now, userCap: 3 }), 'ok');
});

test('the global cap refuses an account that is well under its own', async () => {
  const store = storage();
  const now = new Date('2026-09-12T10:00:00.000Z');
  for (let call = 0; call < 2; call += 1) {
    await reserveCall(OTHER, 'capture_extraction', { storage: store, now, globalCap: 2 });
  }

  const outcome = await reserveCall(UID, 'capture_extraction', { storage: store, now, globalCap: 2 });
  assert.equal(outcome, 'global_cap');
  assert.equal((await callsToday(UID, { storage: store, now })).user, 0, 'the refused account was charged for it');
});

test('the day rolls over at UTC midnight, for everyone at once', async () => {
  const store = storage();
  const lateOnTheTwelfth = new Date('2026-09-12T23:59:59.000Z');
  const earlyOnTheThirteenth = new Date('2026-09-13T00:00:01.000Z');

  await reserveCall(UID, 'capture_extraction', { storage: store, now: lateOnTheTwelfth, userCap: 1 });
  assert.equal(
    await reserveCall(UID, 'capture_extraction', { storage: store, now: lateOnTheTwelfth, userCap: 1 }),
    'user_cap',
  );

  // A minute later, a different day.
  assert.equal(
    await reserveCall(UID, 'capture_extraction', { storage: store, now: earlyOnTheThirteenth, userCap: 1 }),
    'ok',
  );
  assert.equal((await callsToday(UID, { storage: store, now: lateOnTheTwelfth })).user, 1, 'yesterday was rewritten');
  assert.equal((await callsToday(UID, { storage: store, now: earlyOnTheThirteenth })).user, 1);
});

test('the day is the UTC one, not the machine\'s', () => {
  // A per-user local day would let someone in UTC+3 reset three hours early,
  // and the global counter has no timezone to belong to at all.
  assert.equal(utcDay(new Date('2026-09-12T23:30:00.000Z')), '2026-09-12');
  assert.equal(utcDay(new Date('2026-09-13T00:30:00.000Z')), '2026-09-13');
});

test('the caps come from configuration, and a nonsense value does not disable them', async () => {
  const store = storage();
  const now = new Date('2026-09-12T10:00:00.000Z');
  const previous = process.env.MAYBESITTER_LLM_DAILY_CALL_CAP;
  try {
    process.env.MAYBESITTER_LLM_DAILY_CALL_CAP = 'lots';
    // Falls back to the default rather than to "unlimited": a typo in an
    // environment variable must not be how the cost guard is switched off.
    for (let call = 0; call < 3; call += 1) {
      assert.equal(await reserveCall(UID, 'capture_extraction', { storage: store, now }), 'ok');
    }
    assert.ok(DEFAULT_USER_DAILY_CAP > 3 && DEFAULT_GLOBAL_DAILY_CAP > 3);

    process.env.MAYBESITTER_LLM_DAILY_CALL_CAP = '0';
    assert.equal(
      await reserveCall(OTHER, 'capture_extraction', { storage: store, now }),
      'user_cap',
      'an explicit zero should stop every call',
    );
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_LLM_DAILY_CALL_CAP;
    else process.env.MAYBESITTER_LLM_DAILY_CALL_CAP = previous;
  }
});
