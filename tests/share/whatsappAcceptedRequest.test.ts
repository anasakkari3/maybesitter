/**
 * QA v3 staging recheck (2026-11-20), V3-F07: a reminder another person wrote
 * in a shared WhatsApp chat, and the person agreed to, was not read.
 *
 *   «WhatsApp Chat with سامي.txt»
 *   [19/11/2026, 20:16:42] سامي: لا تنسى اجتماع الفريق يوم الأحد الساعة 11 الصبح 📅🔥
 *   [19/11/2026, 20:17:05] أنا: أكيد 👍 وبجيب معي العرض
 *
 * With Gemini: no_commitment. Without the emoji, the capture model was over
 * its minute cap and the rules read the one message the selection had chosen —
 * the reply — and made a card titled with it, «أكيد وبجيب معي العرض». The
 * selection chose the line that says "sure" and not the line that says what
 * and when: it was never told that a request someone else makes, and the
 * person accepts, is the person's to do; and nothing tied an acceptance to the
 * message it answers.
 *
 * Now:
 *  - the selection prompt says so (`whatsapp-selection-v2`);
 *  - a chosen reply that accepts («أكيد», «تمام», "sure", «בטח», 👍) brings the
 *    message it answers with it — the one that says what and when;
 *  - without a model, a reply that accepts is never read on its own: the rules
 *    title a card with the words of the line they read, and a reply read alone
 *    has lost what it answered;
 *  - the rules title «لا تنسى …» / "don't forget …" by what is not to be
 *    forgotten.
 *
 * The model is a stub; nothing is called.
 */
import { seedLiveAccount } from '../support/liveAccount.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { configureCommandService } from '../../lib/services/commandService.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { uidFor } from '../support/fakeAuth.ts';
import { LLMUnavailableError } from '../../src/extraction/llm/index.ts';
import { proposeFromShare, type ShareIntakeContext } from '../../lib/services/share/shareIntakeService.ts';
import { registerSharePreprocessor, resetSharePreprocessorsForTests } from '../../lib/services/share/shareRegistry.ts';
import { plainTextPreprocessor, whatsappPreprocessor } from '../../lib/services/share/channels/index.ts';
import type { LlmPart, ShareStructuredGenerator } from '../../lib/services/share/shareTypes.ts';
import * as whatsappPrompt from '../../lib/services/share/prompts/whatsappPrompt.ts';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';

const USER = uidFor('WhatsAppAcceptedRequestUser');
const ZONE = 'Asia/Jerusalem';
/** The staging run: Friday 2026-11-20 03:39 in Jerusalem. */
const REFERENCE_TIME = '2026-11-20T01:39:00.000Z';
/** Sunday 2026-11-22 11:00 in Jerusalem. */
const SUNDAY_11 = '2026-11-22T09:00:00.000Z';
const REQUEST = 'لا تنسى اجتماع الفريق يوم الأحد الساعة 11 الصبح 📅🔥';
const REPLY = 'أكيد 👍 وبجيب معي العرض';
const SAMI_CHAT = [
  `[19/11/2026, 20:16:42] سامي: ${REQUEST}`,
  `[19/11/2026, 20:17:05] أنا: ${REPLY}`,
].join('\n');
const encoder = new TextEncoder();

function setup(): () => void {
  const directory = mkdtempSync(join(tmpdir(), 'maybesitter-whatsapp-accepted-'));
  const previousDataDir = process.env.MAYBESITTER_DATA_DIR;
  process.env.MAYBESITTER_DATA_DIR = directory;
  configureCommandService({ initialState: createEmptyDomainState(), schedulerStore: null });
  setStorageForTests(createMemoryStorage());
  resetSharePreprocessorsForTests();
  registerSharePreprocessor(plainTextPreprocessor);
  registerSharePreprocessor(whatsappPreprocessor);
  return () => {
    resetStorageForTests();
    if (previousDataDir === undefined) delete process.env.MAYBESITTER_DATA_DIR;
    else process.env.MAYBESITTER_DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  };
}

/** A stand-in selection model that chooses `choose(shown)` and records what it was asked. */
function selection(choose: (shown: number) => number[]) {
  const calls: { system: string; parts: readonly LlmPart[] }[] = [];
  const generate: ShareStructuredGenerator = async (request) => {
    calls.push({ system: request.system, parts: request.parts });
    const shown = request.parts
      .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
      .flatMap((part) => part.text.split('\n'))
      .filter((line) => /^\d+ \| /.test(line)).length;
    return {
      text: JSON.stringify({ commitments: choose(shown).map((index) => ({ index })) }),
      model: 'stub',
      latencyMs: 1,
      promptTokens: 1,
      outputTokens: 1,
    };
  };
  return { calls, generate };
}

async function shareFile(text: string, context: Partial<ShareIntakeContext> = {}) {
  await seedLiveAccount(USER);
  return proposeFromShare(
    {
      files: [{ bytes: encoder.encode(text), declaredType: 'text/plain', fileName: 'WhatsApp Chat with سامي.txt' }],
      timezone: ZONE,
      referenceTime: REFERENCE_TIME,
      locale: 'ar',
    },
    { uid: USER, readAiConsent: async () => 'granted', ...context },
  );
}

function meeting(items: ReadonlyArray<{ title: string; resolvedTime?: string | null }>) {
  return items.find((item) => item.title.includes('اجتماع الفريق'));
}

/* ── the model chose the reply: the request comes with it ───────────── */

test('V3-F07 staging: the model chose only «أكيد…»; the reminder it answers is read too, Sunday 11:00', async () => {
  const teardown = setup();
  try {
    const model = selection(() => [1]);
    const result = await shareFile(SAMI_CHAT, { generateStructured: model.generate });
    assert.equal(result.share.metrics.modelUsed, 1);
    const card = meeting(result.items);
    assert.ok(card, `the team meeting has no card: ${JSON.stringify(result.items.map((item) => item.title))}`);
    assert.equal(card!.resolvedTime, SUNDAY_11);
    // The reply's own words are still read, after the message it answers, and
    // every excerpt is a line of the chat as written.
    assert.equal(result.share.metrics.messagesChosen, 2);
    assert.deepEqual(result.share.evidence.map((entry) => entry.excerpt), [REQUEST, REPLY]);
  } finally {
    teardown();
  }
});

test('V3-F07: a reply that only accepts brings its request and is not read itself', async () => {
  const teardown = setup();
  try {
    const chat = [
      `[19/11/2026, 20:16:42] سامي: ${REQUEST}`,
      '[19/11/2026, 20:17:05] أنا: تمام 👍',
    ].join('\n');
    const result = await shareFile(chat, { generateStructured: selection(() => [1]).generate });
    assert.equal(result.share.metrics.messagesChosen, 1);
    assert.deepEqual(result.share.evidence.map((entry) => entry.excerpt), [REQUEST]);
    assert.equal(meeting(result.items)?.resolvedTime, SUNDAY_11);
  } finally {
    teardown();
  }
});

test('V3-F07: the request is looked for past the person\'s own second reply, from someone else', async () => {
  const teardown = setup();
  try {
    const chat = [
      `[19/11/2026, 20:16:42] سامي: ${REQUEST}`,
      '[19/11/2026, 20:17:05] أنا: أكيد',
      '[19/11/2026, 20:17:09] أنا: 👍',
    ].join('\n');
    const result = await shareFile(chat, { generateStructured: selection(() => [2]).generate });
    assert.deepEqual(result.share.evidence.map((entry) => entry.excerpt), [REQUEST]);
  } finally {
    teardown();
  }
});

test('V3-F07: a model that chose both lines reads each once', async () => {
  const teardown = setup();
  try {
    const result = await shareFile(SAMI_CHAT, { generateStructured: selection(() => [0, 1]).generate });
    assert.equal(result.share.metrics.messagesChosen, 2);
    assert.deepEqual(result.share.evidence.map((entry) => entry.excerpt), [REQUEST, REPLY]);
  } finally {
    teardown();
  }
});

test('V3-F07: a message opening with «أكيد» that answers nobody else is read as written', async () => {
  const teardown = setup();
  try {
    const chat = [
      '[19/11/2026, 20:16:42] أنا: أكيد بكرا الساعة 5 المسا بمر عالبنك',
      '[19/11/2026, 20:17:05] أنا: وبعدين بشتري خبز',
    ].join('\n');
    const result = await shareFile(chat, { generateStructured: selection(() => [0]).generate });
    assert.deepEqual(result.share.evidence.map((entry) => entry.excerpt), ['أكيد بكرا الساعة 5 المسا بمر عالبنك']);
  } finally {
    teardown();
  }
});

/* ── no model: a reply that accepts is never a card of its own ───────── */

for (const [label, context] of [
  ['without AI consent', { readAiConsent: async () => 'declined' as const }],
  ['with the model down', { generateStructured: (async () => { throw new LLMUnavailableError('provider_none'); }) as ShareStructuredGenerator }],
] as const) {
  test(`V3-F07 ${label}: the rules read the reminder, never a card titled with the reply`, async () => {
    const teardown = setup();
    try {
      const result = await shareFile(SAMI_CHAT, context as Partial<ShareIntakeContext>);
      assert.equal(result.share.metrics.modelUsed, 0);
      const titles = result.items.map((item) => item.title);
      assert.ok(!titles.some((title) => title.includes('أكيد')), `a card is titled with the reply: ${JSON.stringify(titles)}`);
      assert.equal(result.items.length, 1, `expected the meeting alone: ${JSON.stringify(titles)}`);
      assert.equal(meeting(result.items)?.resolvedTime, SUNDAY_11);
      assert.doesNotMatch(result.items[0]!.title, /^لا تنسى/, 'the rules kept «لا تنسى» on the title');
      assert.deepEqual(result.share.evidence.map((entry) => entry.excerpt), [REQUEST]);
    } finally {
      teardown();
    }
  });
}

/* ── the prompt ─────────────────────────────────────────────────────── */

test('V3-F07: the selection prompt is versioned and says an accepted request is the person\'s', async () => {
  const teardown = setup();
  try {
    const model = selection(() => []);
    await shareFile(SAMI_CHAT, { generateStructured: model.generate });
    const system = model.calls[0]!.system;
    assert.equal((whatsappPrompt as Record<string, unknown>).WHATSAPP_SELECTION_PROMPT_VERSION, 'whatsapp-selection-v2');
    assert.ok(system.includes(`Prompt version: ${(whatsappPrompt as Record<string, unknown>).WHATSAPP_SELECTION_PROMPT_VERSION}.`), system);
    assert.match(system, /one of the people in this chat/);
    assert.match(system, /«لا تنسى …»/);
    assert.match(system, /return the message that says what and when/);
  } finally {
    teardown();
  }
});

/* ── what an acceptance is ─────────────────────────────────────────── */

test('acceptanceReply: what opens with an acceptance, what is only one, what is neither', () => {
  for (const only of ['تمام 👍', 'أكيد', 'اكيد!', '👍🏽', 'ok', 'Sure.', 'בטח', 'סבבה 👌', 'ماشي، اتفقنا', 'من عيوني']) {
    assert.equal(whatsappPrompt.acceptanceReply?.(only), 'only', only);
  }
  for (const opens of [REPLY, 'sure, and I will bring the slides', 'בסדר, אביא את המצגת', 'تمام بس بتأخر شوي']) {
    assert.equal(whatsappPrompt.acceptanceReply?.(opens), 'opens', opens);
  }
  for (const neither of ['تماما مثل امبارح', 'okayish plan', 'اجتماع الفريق الأحد', 'أكيدًا بكرا', 'شو رأيك؟', 'Okra soup tomorrow']) {
    assert.equal(whatsappPrompt.acceptanceReply?.(neither), null, neither);
  }
});

test('acceptanceReply reads a long message in bounded time', () => {
  const started = performance.now();
  assert.equal(whatsappPrompt.acceptanceReply?.(`تمام ${'و'.repeat(20_000)}`), 'opens');
  assert.equal(whatsappPrompt.acceptanceReply?.(`${'ت'.repeat(20_000)}`), null);
  assert.ok(performance.now() - started < 200);
});

/* ── the rules' title for «لا تنسى» ───────────────────────────────── */

test('rules: «لا تنسى …», "don\'t forget to …" and «אל תשכח …» are titled by what is not to be forgotten', () => {
  const context = { now: new Date(REFERENCE_TIME), timezone: ZONE };
  assert.equal(extract('لا تنسى اجتماع الفريق يوم الأحد الساعة 11 الصبح', context).title, 'اجتماع الفريق');
  assert.equal(extract('ما تنسى تتصل بأمك بكرا', context).title, 'تتصل بأمك');
  assert.equal(extract("don't forget to email the doctor on Sunday", context).title, 'email the doctor');
  assert.equal(extract('אל תשכח להתקשר לאמא מחר', context).title, 'להתקשר לאמא');
  // Never onto the object marker, as «תזכיר לי את…» keeps its verb.
  assert.match(extract('אל תשכח את הפגישה ביום ראשון', context).title ?? '', /^אל תשכח את הפגישה/);
});
