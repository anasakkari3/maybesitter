/**
 * The multipart seam four channels are about to build on (UC-3.0, #183).
 *
 * `generateStructured` is the prerequisite #189–#192 each need, and the things
 * that have to be true of it are not "it returns a string":
 *
 *  - **the consent gate covers it.** It is a required member of `LlmProvider`
 *    precisely so a wrapper cannot be written without one, and the gate has to
 *    actually refuse a multipart call for an account that has not agreed;
 *  - **it maps parts to Vertex correctly**, including a byte array that is a
 *    window onto a larger buffer — which is what slicing a request body gives
 *    you, and which a naive `Buffer.from(view)` copies whole;
 *  - **`promptTokens` survives.** #190 needs it for a token cost guard, and a
 *    wrapper that dropped it would make that guard unwritable;
 *  - **the cost guard runs before the call**, and a refusal costs nothing;
 *  - **nothing a person shared reaches a log line.**
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STRUCTURED_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  LLMUnavailableError,
  createGeminiProvider,
  structuredFromJson,
  withSingleRetry,
  type GenerateContent,
  type LlmProvider,
} from '../../src/extraction/llm/index.ts';
import { consentGatedProvider, AiConsentRequiredError } from '../../lib/llm/consentGatedProvider.ts';
import { shareLlmProvider, MAX_INLINE_BYTES, MAX_SHARE_CHARACTERS } from '../../lib/llm/shareProvider.ts';
import { wrapUntrustedShared } from '../../lib/services/share/shareTypes.ts';

const UID = 'ShareProviderUserxxxxxxxxxxxx';
const SCHEMA = { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } };

function request(parts: Parameters<ReturnType<typeof shareLlmProvider>>[0]['parts']) {
  return { system: 'rules', parts, responseSchema: SCHEMA };
}

/** A provider that records the request it was handed. */
function recording(text = '{"items":[]}'): LlmProvider & { calls: unknown[] } {
  const calls: unknown[] = [];
  const answer = async (input: unknown) => {
    calls.push(input);
    return { text, model: 'gemini-2.5-flash', latencyMs: 3, promptTokens: 1234, outputTokens: 7 };
  };
  return { name: 'gemini', calls, generateJson: answer, generateStructured: answer } as unknown as
    LlmProvider & { calls: unknown[] };
}

async function capturingLogs<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const record = (...args: unknown[]) => { lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.log = record; console.info = record; console.warn = record; console.error = record;
  try {
    return { value: await run(), lines };
  } finally {
    Object.assign(console, originals);
  }
}

/* ── Deadlines and cancellation ──────────────────────────────────── */

/**
 * A provider double that takes `delayMs` to answer and honours the abort signal
 * it is handed, the way the real SDK does.
 *
 * Honouring it is the whole point: without that, a "timed out" assertion passes
 * against a provider that installs no timer at all, and an "aborted" assertion
 * passes against one that drops the caller's signal on the floor.
 */
function slowGenerate(delayMs: number): GenerateContent {
  return async (input) => {
    const signal = (input as unknown as { config?: { abortSignal?: AbortSignal } }).config?.abortSignal;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ text: '{"ok":true}', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
        delayMs,
      );
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }) as Awaited<ReturnType<GenerateContent>>;
  };
}

test('a multipart call gets its own deadline, not the one-sentence one', async () => {
  // The text path's 8 s is sized for forty characters. This seam permits 12 MB
  // of inline data, every byte of which is base64'd and uploaded before the
  // model reads a token — sharing that deadline would time out every large
  // share and report it as an outage.
  assert.ok(DEFAULT_STRUCTURED_TIMEOUT_MS > DEFAULT_TIMEOUT_MS * 4);

  // Answers after 30 ms unless the deadline the provider installed fires first,
  // so what is asserted is the timer actually installed rather than a number
  // read back off the request object.
  const provider = createGeminiProvider({
    generate: slowGenerate(30),
    project: 'p',
    location: 'europe-west1',
    timeoutMs: 10,
  });
  // `generateJson` is held to the 10 ms this provider was built with...
  await assert.rejects(
    () => provider.generateJson({ system: '', user: 'x', responseSchema: {}, purpose: 'capture_extraction', uid: 'u' }),
    (error: unknown) => error instanceof LLMUnavailableError,
  );
  // ...and the multipart call is not, because it asks for its own.
  const answered = await provider.generateStructured({
    system: '',
    parts: [{ kind: 'text', text: 'x' }],
    responseSchema: {},
    purpose: 'share_extraction',
    uid: 'u',
    timeoutMs: 5_000,
  });
  assert.equal(answered.text, '{"ok":true}');
});

test('a caller\u2019s abort stops the call rather than being ignored', async () => {
  const provider = createGeminiProvider({
    generate: slowGenerate(200),
    project: 'p',
    location: 'europe-west1',
    timeoutMs: 10_000,
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  // A share the user backed out of should stop costing money immediately. The
  // seam documents `signal` as "pass it to anything cancellable"; before this it
  // had nowhere to go.
  await assert.rejects(
    () => provider.generateStructured({
      system: '',
      parts: [{ kind: 'text', text: 'x' }],
      responseSchema: {},
      purpose: 'share_extraction',
      uid: 'u',
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof LLMUnavailableError,
  );
});

test('a channel can ask whether this account agreed, without that being the gate', async () => {
  // Provided so a channel can pick a non-model path before spending a call that
  // would be refused anyway. It is not the gate: `generateStructured` refuses
  // whatever this says, because a channel that forgot to ask must not get
  // through.
  const generator = shareLlmProvider('uid-consent', {
    provider: { name: 'gemini', generateJson: async () => { throw new Error('unused'); }, generateStructured: async () => ({ text: '{}', model: 'm', latencyMs: 1, promptTokens: 1, outputTokens: 1 }) },
    consent: async () => 'declined',
    reserve: async () => 'ok',
    log: () => {},
    commit: async () => {},
  });
  await assert.rejects(
    () => generator({ system: '', parts: [{ kind: 'text', text: 'x' }], responseSchema: {} }),
    (error: unknown) => error instanceof AiConsentRequiredError,
  );
});

/* ── The Vertex mapping ──────────────────────────────────────────── */

test('parts become Vertex contents in the order they were given', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const generate: GenerateContent = async (input) => {
    seen.push(input as unknown as Record<string, unknown>);
    return { text: '{"ok":true}', modelVersion: 'gemini-2.5-flash-001', usageMetadata: { promptTokenCount: 99, candidatesTokenCount: 4 } };
  };
  const provider = createGeminiProvider({ generate, project: 'p', location: 'europe-west1' });

  const response = await provider.generateStructured({
    system: 'the rules',
    parts: [
      { kind: 'text', text: 'before' },
      { kind: 'inlineData', mediaType: 'image/png', data: new Uint8Array([1, 2, 3, 4]) },
      { kind: 'text', text: 'after' },
    ],
    responseSchema: SCHEMA,
    purpose: 'share_extraction',
    uid: UID,
    maxOutputTokens: 512,
  });

  const contents = (seen[0]!.contents as Array<{ parts: unknown[] }>)[0]!.parts;
  assert.deepEqual(contents, [
    { text: 'before' },
    { inlineData: { mimeType: 'image/png', data: Buffer.from([1, 2, 3, 4]).toString('base64') } },
    { text: 'after' },
  ]);
  const config = seen[0]!.config as Record<string, unknown>;
  assert.equal(config.systemInstruction, 'the rules');
  assert.equal(config.maxOutputTokens, 512);
  assert.equal(config.responseMimeType, 'application/json');
  // The counts survive the whole way out. #190 reads `promptTokens`.
  assert.equal(response.promptTokens, 99);
  assert.equal(response.outputTokens, 4);
  assert.equal(response.model, 'gemini-2.5-flash-001');
});

test('a byte array that is a window onto a larger buffer sends only its window', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const generate: GenerateContent = async (input) => {
    seen.push(input as unknown as Record<string, unknown>);
    return { text: '{}', usageMetadata: {} };
  };
  const provider = createGeminiProvider({ generate, project: 'p' });

  // What slicing a multipart body gives you: a view over a shared buffer, with
  // the neighbouring file's bytes on either side of it.
  const backing = new Uint8Array([9, 9, 9, 1, 2, 3, 9, 9]);
  const window = backing.subarray(3, 6);
  await provider.generateStructured({
    system: '',
    parts: [{ kind: 'inlineData', mediaType: 'application/pdf', data: window }],
    responseSchema: SCHEMA,
    purpose: 'share_extraction',
    uid: UID,
  });

  const part = (seen[0]!.contents as Array<{ parts: Array<{ inlineData: { data: string } }> }>)[0]!.parts[0]!;
  assert.equal(part.inlineData.data, Buffer.from([1, 2, 3]).toString('base64'));
});

test('a structured request with no parts is refused rather than sent', async () => {
  let called = 0;
  const generate: GenerateContent = async () => { called += 1; return { text: '{}' }; };
  const provider = createGeminiProvider({ generate, project: 'p' });
  await assert.rejects(
    () => provider.generateStructured({ system: '', parts: [], responseSchema: SCHEMA, purpose: 'share_extraction', uid: UID }),
    (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'empty_request',
  );
  assert.equal(called, 0);
});

/* ── The wrappers ────────────────────────────────────────────────── */

test('the consent gate refuses a multipart call for an account that has not agreed', async () => {
  const inner = recording();
  const gated = consentGatedProvider(UID, { provider: inner, consent: async () => 'declined' });
  await assert.rejects(
    () => gated.generateStructured({ system: '', parts: [{ kind: 'text', text: 'hi' }], responseSchema: SCHEMA, purpose: 'share_extraction', uid: UID }),
    AiConsentRequiredError,
  );
  assert.deepEqual(inner.calls, [], 'the gate let a multipart call through');
});

test('the retry wrapper retries a multipart call on the same terms', async () => {
  let calls = 0;
  const flaky: LlmProvider = {
    name: 'gemini',
    async generateJson() { throw new LLMUnavailableError('server_error'); },
    async generateStructured() {
      calls += 1;
      if (calls === 1) throw new LLMUnavailableError('server_error');
      return { text: '{}', model: 'm', latencyMs: 1, promptTokens: 0, outputTokens: 0 };
    },
  };
  const response = await withSingleRetry(flaky, { delayMs: () => 0 }).generateStructured({
    system: '', parts: [{ kind: 'text', text: 'x' }], responseSchema: SCHEMA, purpose: 'share_extraction', uid: UID,
  });
  assert.equal(response.text, '{}');
  assert.equal(calls, 2);
});

test('a text-only provider refuses bytes rather than dropping them', async () => {
  const structured = structuredFromJson(async (input) => ({
    text: input.user, model: 'm', latencyMs: 0, promptTokens: 0, outputTokens: 0,
  }));
  const joined = await structured({
    system: '', parts: [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }],
    responseSchema: SCHEMA, purpose: 'share_extraction', uid: UID,
  });
  assert.equal(joined.text, 'a\n\nb');

  await assert.rejects(
    () => structured({
      system: '',
      parts: [{ kind: 'inlineData', mediaType: 'image/png', data: new Uint8Array([1]) }],
      responseSchema: SCHEMA, purpose: 'share_extraction', uid: UID,
    }),
    (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'inline_data_unsupported',
  );
});

/* ── The metered generator a channel is given ────────────────────── */

test('a share model call is reserved, committed and logged with counts only', async () => {
  const inner = recording('{"items":["dentist"]}');
  const committed: Array<Record<string, unknown>> = [];
  const logged: Array<Record<string, unknown>> = [];
  const generate = shareLlmProvider(UID, {
    provider: inner,
    consent: async () => 'granted',
    reserve: async () => 'ok',
    commit: async (_uid, tokens) => { committed.push(tokens as Record<string, unknown>); },
    log: (entry) => { logged.push(entry as unknown as Record<string, unknown>); },
  });

  const SECRET = 'Dr-Haddad-XYZZY';
  const response = await generate(request([wrapUntrustedShared(`meet ${SECRET} at 4`)]));

  assert.equal(response.text, '{"items":["dentist"]}');
  assert.equal(response.promptTokens, 1234);
  assert.deepEqual(committed, [{ promptTokens: 1234, outputTokens: 7 }]);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.outcome, 'ok');
  assert.equal(logged[0]!.purpose, 'share_extraction');
  assert.ok(!JSON.stringify(logged).includes(SECRET), 'shared text reached the log line');
  assert.ok(!JSON.stringify(logged).includes(UID), 'the raw uid reached the log line');
});

test('a call over the cost cap never reaches the provider and commits nothing', async () => {
  const inner = recording();
  const committed: unknown[] = [];
  const generate = shareLlmProvider(UID, {
    provider: inner,
    consent: async () => 'granted',
    reserve: async () => 'user_minute_cap',
    commit: async (_uid, tokens) => { committed.push(tokens); },
    log: () => {},
  });
  await assert.rejects(
    () => generate(request([{ kind: 'text', text: 'x' }])),
    (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'cost_cap:user_minute',
  );
  assert.deepEqual(inner.calls, []);
  assert.deepEqual(committed, []);
});

test('an oversized multipart call is refused before it is reserved', async () => {
  const inner = recording();
  let reserved = 0;
  const generate = shareLlmProvider(UID, {
    provider: inner,
    consent: async () => 'granted',
    reserve: async () => { reserved += 1; return 'ok'; },
    log: () => {},
  });

  await assert.rejects(
    () => generate(request([{ kind: 'inlineData', mediaType: 'image/png', data: new Uint8Array(MAX_INLINE_BYTES + 1) }])),
    (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'input_too_large',
  );
  await assert.rejects(
    () => generate(request([{ kind: 'text', text: 'x'.repeat(MAX_SHARE_CHARACTERS + 1) }])),
    (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'input_too_large',
  );
  assert.equal(reserved, 0);
  assert.deepEqual(inner.calls, []);
});

test('an account that has not agreed is refused before the reservation is spent', async () => {
  const inner = recording();
  let reserved = 0;
  const generate = shareLlmProvider(UID, {
    provider: inner,
    consent: async () => 'declined',
    reserve: async () => { reserved += 1; return 'ok'; },
    log: () => {},
  });
  await assert.rejects(() => generate(request([{ kind: 'text', text: 'x' }])), AiConsentRequiredError);
  assert.equal(reserved, 0);
  assert.deepEqual(inner.calls, []);
});

test('a provider failure is reported as a reason, never as its message', async () => {
  const inner: LlmProvider = {
    name: 'gemini',
    async generateJson() { throw new Error('quota exceeded for project maybesitter-app'); },
    async generateStructured() { throw new Error('quota exceeded for project maybesitter-app'); },
  };
  const generate = shareLlmProvider(UID, {
    provider: inner,
    consent: async () => 'granted',
    reserve: async () => 'ok',
    log: () => {},
  });
  const { lines } = await capturingLogs(async () => {
    await assert.rejects(
      () => generate(request([{ kind: 'text', text: 'x' }])),
      (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'provider_error',
    );
  });
  assert.ok(!lines.join('\n').includes('maybesitter-app'), 'a provider message reached a log line');
});
