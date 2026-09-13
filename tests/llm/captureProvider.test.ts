/**
 * The model call as the capture path makes it (UC-2.0, #160).
 *
 * Two claims, and the second is the one that would be embarrassing to get
 * wrong:
 *
 *   1. **Every call is paid for first.** The reservation happens before Vertex
 *      is asked, including the repair attempt, so "150 calls a day" counts
 *      calls rather than captures.
 *   2. **Nothing a person wrote is logged.** #160's acceptance criterion names
 *      an input — `سر123` — and requires it to appear nowhere in the output.
 *      This asserts that over the whole log line, for a successful call and a
 *      failing one, because a provider's error message is exactly where such a
 *      string tends to reappear.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMUnavailableError, type LlmProvider } from '../../src/extraction/llm/index.ts';
import { captureLlmProvider, splitPrompt } from '../../lib/llm/captureProvider.ts';
import type { LlmCallLog } from '../../lib/llm/llmLog.ts';
import { uidHash } from '../../lib/llm/llmLog.ts';
import type { ReservationOutcome } from '../../lib/llm/usageGuard.ts';

const UID = 'user_capture_provider';
const SECRET = 'سر123';
const PROMPT = [
  'SYSTEM ROLE: You are the deterministic MaybeSitter structured extraction engine.',
  'Reference datetime: 2026-09-12T09:00:00.000Z',
  'BEGIN_UNTRUSTED_USER_MESSAGE',
  JSON.stringify(`ذكرني ${SECRET} بكرا الساعة 7`),
  'END_UNTRUSTED_USER_MESSAGE',
].join('\n');

function answering(text: string): LlmProvider & { requests: Array<{ system: string; user: string }> } {
  const requests: Array<{ system: string; user: string }> = [];
  return {
    name: 'gemini',
    requests,
    async generateJson(request) {
      requests.push({ system: request.system, user: request.user });
      return { text, model: 'gemini-2.5-flash', latencyMs: 12, promptTokens: 66, outputTokens: 46 };
    },
  } as LlmProvider & { requests: Array<{ system: string; user: string }> };
}

function failing(error: unknown): LlmProvider {
  return {
    name: 'gemini',
    async generateJson() {
      throw error;
    },
  };
}

/** This account agreed. #161's own refusal path is asserted separately. */
const granted = (async () => 'granted') as never;

function recorder() {
  const lines: LlmCallLog[] = [];
  return { lines, log: (entry: LlmCallLog) => void lines.push(entry) };
}

function reserver(outcomes: ReservationOutcome[]) {
  const calls: string[] = [];
  const reserve = async (uid: string) => {
    calls.push(uid);
    return outcomes[calls.length - 1] ?? 'ok';
  };
  return { calls, reserve: reserve as never };
}

test('a call is reserved before the provider is asked', async () => {
  const provider = answering('{"type":"task"}');
  const { calls, reserve } = reserver(['ok']);
  const { lines, log } = recorder();

  const text = await captureLlmProvider(UID, { provider, reserve, log, consent: granted })(PROMPT);

  assert.equal(text, '{"type":"task"}');
  assert.deepEqual(calls, [UID], 'the call was made without being reserved');
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.outcome, 'ok');
  assert.equal(lines[0]!.promptTokens, 66);
});

test('every call reserves, so the repair attempt is paid for too', async () => {
  // The extractor asks again after a schema failure. That second request is a
  // second model call, and a cap that ignored it would be wrong by up to
  // double.
  const provider = answering('{}');
  const { calls, reserve } = reserver(['ok', 'ok']);
  const call = captureLlmProvider(UID, { provider, reserve, log: () => {}, consent: granted });

  await call(PROMPT);
  await call(PROMPT);

  assert.deepEqual(calls, [UID, UID], 'the second call was free');
});

test('over the cap, the provider is never asked and the reason names which cap', async () => {
  // The reason names the *scope* a user is told about, not the internal counter:
  // both daily caps read as `user_daily`, and the minute cap is its own, because
  // it clears in seconds and deserves a different answer (#181).
  for (const [outcome, reason] of [
    ['user_cap', 'cost_cap:user_daily'],
    ['user_token_cap', 'cost_cap:user_daily'],
    ['user_minute_cap', 'cost_cap:user_minute'],
    ['global_cap', 'cost_cap:global_daily'],
  ] as const) {
    const provider = answering('{"type":"task"}');
    const { reserve } = reserver([outcome]);
    const { lines, log } = recorder();

    await assert.rejects(
      () => captureLlmProvider(UID, { provider, reserve, log, consent: granted })(PROMPT),
      (error: unknown) => error instanceof LLMUnavailableError && error.reason === reason,
    );

    assert.equal(provider.requests.length, 0, 'a capped call still reached the provider');
    assert.equal(lines[0]?.outcome, 'cost_cap');
    assert.equal(lines[0]?.fallbackReason, reason);
  }
});

test('a provider that is switched off costs nothing and reserves nothing', async () => {
  const { calls, reserve } = reserver([]);
  const off: LlmProvider = { name: 'none', async generateJson() { throw new LLMUnavailableError('provider_none'); } };

  await assert.rejects(
    () => captureLlmProvider(UID, { provider: off, reserve, log: () => {}, consent: granted })(PROMPT),
    (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'provider_none',
  );
  assert.deepEqual(calls, [], 'a call nobody made was counted against the budget');
});

test('the instructions go as instructions and the user text as content', () => {
  const { system, user } = splitPrompt(PROMPT);
  assert.match(system, /SYSTEM ROLE/);
  assert.equal(system.includes(SECRET), false, 'the user text leaked into the system instruction');
  assert.match(user, /^BEGIN_UNTRUSTED_USER_MESSAGE/);
  assert.equal(user.includes(SECRET), true);

  // A prompt built some other way is treated as entirely untrusted, which is
  // the safe direction to be wrong in.
  assert.deepEqual(splitPrompt('no marker here'), { system: '', user: 'no marker here' });
});

test('the log line contains nothing the user wrote, on success or on failure', async () => {
  const { lines, log } = recorder();
  const { reserve } = reserver(['ok', 'ok']);

  await captureLlmProvider(UID, { provider: answering(`{"action":"${SECRET}"}`), reserve, log, consent: granted })(PROMPT);
  await assert.rejects(
    () => captureLlmProvider(UID, {
      // The shape of a real provider failure: the message quotes the request.
      provider: failing(new LLMUnavailableError('provider_error:400', `INVALID_ARGUMENT: could not parse "${SECRET}"`)),
      reserve,
      log,
      consent: granted,
    })(PROMPT),
  );

  assert.equal(lines.length, 2);
  const serialised = JSON.stringify(lines);
  assert.equal(serialised.includes(SECRET), false, `a log line carried the user's text: ${serialised}`);
  assert.equal(serialised.includes('BEGIN_UNTRUSTED'), false, 'a log line carried the prompt');
  assert.equal(serialised.includes(UID), false, 'a log line carried the raw uid');
  assert.equal(lines[1]!.fallbackReason, 'provider_error:400', 'the failure was not named');
});

test('the uid is a stable pseudonym, not the uid and not nothing', async () => {
  // Omitting it would make "one account is looping" unanswerable; including it
  // would put an account identifier in every log line.
  assert.equal(uidHash(UID), uidHash(UID));
  assert.notEqual(uidHash(UID), uidHash('another-uid'));
  assert.equal(uidHash(UID).length, 16);
  assert.equal(uidHash(UID).includes(UID), false);
});

test('an account that has not agreed is never charged and never reaches the provider', async () => {
  // Consent is checked before the reservation on purpose: refusing after
  // charging would spend somebody's daily budget on a call their consent
  // forbids. The provider itself refuses again — that is the layer that cannot
  // be bypassed — but this is the order a user would notice.
  const provider = answering('{"type":"task"}');
  const { calls, reserve } = reserver(['ok']);
  const { lines, log } = recorder();
  const declined = (async () => 'declined') as never;

  await assert.rejects(
    () => captureLlmProvider(UID, { provider, reserve, log, consent: declined })(PROMPT),
    (error: unknown) => (error as LLMUnavailableError).reason === 'consent_required',
  );

  assert.deepEqual(calls, [], 'a declined account was charged for a call it never made');
  assert.equal(provider.requests.length, 0, 'a declined account reached the provider');
  assert.deepEqual(lines, [], 'a call that never happened was logged as one');
});
