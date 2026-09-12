/**
 * The hosted-model seam (UC-2.0, #160).
 *
 * Three things are being pinned here, and only one of them is "does it call
 * the model":
 *
 *   1. **It is off unless someone turned it on.** #160's own scope says user
 *      text must not reach Vertex before UC-2.1 (#161)'s consent enforcement.
 *      A default that switches on with `NODE_ENV` would have sent it the
 *      moment this deployed, so the default is `none` everywhere and a test
 *      says so.
 *   2. **Every failure lands on fallback.** Capture must survive a model that
 *      is slow, throttled, broken or switched off — and it must survive each
 *      of them the same way.
 *   3. **Nothing user-shaped escapes.** The reason a fallback happened is our
 *      word, never the provider's message, because a provider's message can
 *      quote the request and the request is what the person typed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LLMUnavailableError,
  configuredProviderName,
  createGeminiProvider,
  getDefaultProvider,
  resetProviderForTests,
  withSingleRetry,
  type GenerateContent,
  type LlmProvider,
  type LlmRequest,
} from '../../src/extraction/llm/index.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readSource = (relative: string) => readFileSync(join(repoRoot, relative), 'utf8');

const REQUEST: LlmRequest = {
  system: 'Extract a task.',
  user: 'BEGIN_UNTRUSTED_USER_MESSAGE\nwater the plants at 7\nEND_UNTRUSTED_USER_MESSAGE',
  responseSchema: { type: 'object' },
  purpose: 'capture_extraction',
  uid: 'user_llm_test',
};

/** A Vertex response shaped like the real one, with only what is read. */
function answering(text: string): GenerateContent {
  return async () => ({
    text,
    modelVersion: 'gemini-2.5-flash',
    usageMetadata: { promptTokenCount: 66, candidatesTokenCount: 46 },
  });
}

function failingWith(error: unknown): GenerateContent {
  return async () => {
    throw error;
  };
}

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetProviderForTests();
  try {
    return run();
  } finally {
    for (const [key, value] of Array.from(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetProviderForTests();
  }
}

/* ── Selection ────────────────────────────────────────────────────── */

test('the default provider is none, in every environment', () => {
  // The one that matters. #160 proposed defaulting to Gemini in production;
  // doing that would have sent capture text to Vertex before anyone had been
  // asked for consent (#161).
  for (const nodeEnv of ['production', 'development', 'test']) {
    withEnv({ MAYBESITTER_LLM_PROVIDER: undefined, NODE_ENV: nodeEnv }, () => {
      assert.equal(configuredProviderName(), 'none', `NODE_ENV=${nodeEnv} changed the default`);
      assert.equal(getDefaultProvider().name, 'none');
    });
  }
});

test('a configured provider is used, and a misspelled one is refused rather than ignored', () => {
  withEnv({ MAYBESITTER_LLM_PROVIDER: 'gemini' }, () => assert.equal(getDefaultProvider().name, 'gemini'));
  withEnv({ MAYBESITTER_LLM_PROVIDER: 'ollama' }, () => assert.equal(getDefaultProvider().name, 'ollama'));
  withEnv({ MAYBESITTER_LLM_PROVIDER: 'none' }, () => assert.equal(getDefaultProvider().name, 'none'));

  // "gemeni" silently meaning "off" is an outage that looks like normal
  // fallback for as long as nobody reads the logs.
  withEnv({ MAYBESITTER_LLM_PROVIDER: 'gemeni' }, () => {
    assert.throws(() => configuredProviderName(), /must be gemini, ollama or none/);
  });
});

test('the none provider fails immediately, which is what makes capture unaffected', async () => {
  await withEnv({ MAYBESITTER_LLM_PROVIDER: 'none' }, async () => {
    await assert.rejects(
      () => getDefaultProvider().generateJson(REQUEST),
      (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'provider_none',
    );
  });
});

/* ── The Gemini provider ──────────────────────────────────────────── */

test('a structured answer comes back with what it cost', async () => {
  const provider = createGeminiProvider({ generate: answering('{"type":"task"}'), model: 'gemini-2.5-flash' });
  const response = await provider.generateJson(REQUEST);

  assert.equal(response.text, '{"type":"task"}');
  assert.equal(response.model, 'gemini-2.5-flash');
  assert.equal(response.promptTokens, 66);
  assert.equal(response.outputTokens, 46);
  assert.ok(response.latencyMs >= 0);
});

test('the request separates instructions from the untrusted message', async () => {
  // If the user's text were concatenated into the system instruction, the
  // BEGIN/END wrapper would be decoration and the injection guard would be
  // the only thing between a crafted sentence and the model's instructions.
  let seen: { config?: Record<string, unknown>; contents?: unknown } = {};
  const provider = createGeminiProvider({
    generate: async (input) => {
      seen = input;
      return { text: '{}', usageMetadata: {} };
    },
  });
  await provider.generateJson(REQUEST);

  assert.equal(seen.config?.systemInstruction, REQUEST.system);
  assert.equal(JSON.stringify(seen.contents).includes('water the plants'), true);
  assert.equal(String(seen.config?.systemInstruction).includes('water the plants'), false);
  assert.equal(seen.config?.responseMimeType, 'application/json');
  assert.equal(seen.config?.temperature, 0);
  assert.deepEqual(seen.config?.thinkingConfig, { thinkingBudget: 0 });
});

test('every kind of provider failure becomes one error with a reason of ours', async () => {
  const cases: Array<[unknown, string]> = [
    [Object.assign(new Error('too many requests'), { status: 429 }), 'rate_limited'],
    [Object.assign(new Error('backend error'), { status: 503 }), 'server_error'],
    [new Error('UNAVAILABLE: the service is currently unavailable'), 'unavailable'],
    [new Error('DEADLINE_EXCEEDED'), 'unavailable'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout'],
    [Object.assign(new Error('bad schema'), { status: 400 }), 'provider_error:400'],
  ];

  for (const [thrown, reason] of cases) {
    const provider = createGeminiProvider({ generate: failingWith(thrown) });
    await assert.rejects(
      () => provider.generateJson(REQUEST),
      (error: unknown) => error instanceof LLMUnavailableError && error.reason === reason,
      `${String(thrown)} should map to ${reason}`,
    );
  }
});

test('a provider error never carries the provider\'s own message', async () => {
  // The body of a Vertex error can quote the request that failed, and the
  // request is the user's sentence.
  const secret = 'سر123 water the plants';
  const provider = createGeminiProvider({
    generate: failingWith(Object.assign(new Error(`INVALID_ARGUMENT: could not process "${secret}"`), { status: 400 })),
  });

  await assert.rejects(
    () => provider.generateJson(REQUEST),
    (error: unknown) => {
      const serialised = `${(error as Error).name} ${(error as Error).message} ${(error as LLMUnavailableError).reason}`;
      assert.equal(serialised.includes(secret), false, `the error carried the request: ${serialised}`);
      return true;
    },
  );
});

test('an empty or filtered answer is a failure, not an empty extraction', async () => {
  const provider = createGeminiProvider({
    generate: async () => ({ text: '', candidates: [{ finishReason: 'SAFETY' }], usageMetadata: {} }),
  });
  await assert.rejects(
    () => provider.generateJson(REQUEST),
    (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'empty_response:SAFETY',
  );
});

test('a timeout aborts the call rather than waiting on the provider', async () => {
  let aborted = false;
  const provider = createGeminiProvider({
    timeoutMs: 20,
    generate: (input) => new Promise((_resolve, reject) => {
      const signal = input.config.abortSignal as AbortSignal;
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }),
  });

  await assert.rejects(
    () => provider.generateJson(REQUEST),
    (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'timeout',
  );
  assert.equal(aborted, true, 'the deadline did not abort the request');
});

test('the location must be a region, never global', async () => {
  await assert.rejects(
    () => createGeminiProvider({ location: 'global' }).generateJson(REQUEST),
    /never "global"/,
  );
});

test('no code path reads an API key', () => {
  // ADC only. A key that exists is a key that can leak, and the acceptance
  // criterion greps for exactly this.
  const sources = ['geminiProvider.ts', 'index.ts', 'llmProvider.ts', 'vertexSchema.ts']
    .map((file) => readSource(`src/extraction/llm/${file}`))
    .join('\n');
  assert.equal(/apiKey|API_KEY|GEMINI_KEY|GOOGLE_API_KEY/.test(sources), false, 'an API key path exists');
  assert.equal(sources.includes('vertexai: true'), true, 'the client is not in Vertex mode');
});

/* ── Retry ───────────────────────────────────────────────────────── */

function countingProvider(outcomes: Array<'fail-retryable' | 'fail-terminal' | 'ok'>): LlmProvider & { calls: number } {
  let calls = 0;
  const provider = {
    name: 'gemini' as const,
    get calls() {
      return calls;
    },
    async generateJson() {
      const outcome = outcomes[calls] ?? 'ok';
      calls += 1;
      if (outcome === 'fail-retryable') throw new LLMUnavailableError('server_error');
      if (outcome === 'fail-terminal') throw new LLMUnavailableError('provider_error:400');
      return { text: '{}', model: 'm', latencyMs: 1, promptTokens: 0, outputTokens: 0 };
    },
  };
  return provider as LlmProvider & { calls: number };
}

test('a retryable failure is retried once and can then succeed', async () => {
  const inner = countingProvider(['fail-retryable', 'ok']);
  const response = await withSingleRetry(inner, { delayMs: () => 0 }).generateJson(REQUEST);
  assert.equal(response.text, '{}');
  assert.equal(inner.calls, 2);
});

test('a second failure is not retried again', async () => {
  const inner = countingProvider(['fail-retryable', 'fail-retryable']);
  await assert.rejects(() => withSingleRetry(inner, { delayMs: () => 0 }).generateJson(REQUEST));
  assert.equal(inner.calls, 2, 'more than one retry would be a retry storm during an outage');
});

test('a failure that cannot differ next time is not retried at all', async () => {
  const inner = countingProvider(['fail-terminal', 'ok']);
  await assert.rejects(
    () => withSingleRetry(inner, { delayMs: () => 0 }).generateJson(REQUEST),
    (error: unknown) => (error as LLMUnavailableError).reason === 'provider_error:400',
  );
  assert.equal(inner.calls, 1, 'a 400 was retried, spending the deadline twice for the same answer');
});
