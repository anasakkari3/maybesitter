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
import { acceptanceReply, WHATSAPP_SELECTION_PROMPT_VERSION } from '../../lib/services/share/prompts/whatsappPrompt.ts';
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
    assert.equal(WHATSAPP_SELECTION_PROMPT_VERSION, 'whatsapp-selection-v2');
    assert.ok(system.includes(`Prompt version: ${WHATSAPP_SELECTION_PROMPT_VERSION}.`), system);
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
    assert.equal(acceptanceReply(only), 'only', only);
  }
  for (const opens of [REPLY, 'sure, and I will bring the slides', 'בסדר, אביא את המצגת', 'تمام بس بتأخر شوي']) {
    assert.equal(acceptanceReply(opens), 'opens', opens);
  }
  for (const neither of ['تماما مثل امبارح', 'okayish plan', 'اجتماع الفريق الأحد', 'أكيدًا بكرا', 'شو رأيك؟', 'Okra soup tomorrow']) {
    assert.equal(acceptanceReply(neither), null, neither);
  }
});

test('acceptanceReply reads a long message in bounded time', () => {
  const started = performance.now();
  assert.equal(acceptanceReply(`تمام ${'و'.repeat(20_000)}`), 'opens');
  assert.equal(acceptanceReply(`${'ت'.repeat(20_000)}`), null);
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

/* ── review round (2026-11-20): refusals, the window, the bounds, «لا تنسى إنه» ── */

test('review 5: «أكيد لأ», "sure, no", «בטח שלא» and 👎 refuse; 😂 and 🙂 accept nothing', () => {
  for (const refusal of ['أكيد لأ', 'تمام بس مش رح أقدر', 'أكيد لا', 'sure, no', "ok but I can't", 'okay, I won\'t make it', 'ברור שלא', 'בטח שלא', 'בסדר, לא אוכל', '👎', 'تمام 👎', '😂', '🙂']) {
    assert.equal(acceptanceReply(refusal), null, refusal);
  }
  for (const yes of ['أكيد، ما في مشكلة', 'sure, no problem', 'ok, no worries', 'אין בעיה', 'تمام ولا يهمك', '👌', '✅']) {
    assert.equal(acceptanceReply(yes), 'only', yes);
  }
});

test('review 5: a refusal of the reminder does not bring the reminder in', async () => {
  const teardown = setup();
  try {
    const chat = [
      `[19/11/2026, 20:16:42] سامي: ${REQUEST}`,
      '[19/11/2026, 20:17:05] أنا: أكيد لأ، مش فاضي',
    ].join('\n');
    const result = await shareFile(chat, { generateStructured: selection(() => [1]).generate });
    assert.equal(result.share.metrics.messagesChosen, 1);
    assert.equal(meeting(result.items), undefined, `a refused reminder became a card: ${JSON.stringify(result.items.map((item) => item.title))}`);
  } finally {
    teardown();
  }
});

test('review 7 (M9): the request is looked for three messages back, not four', async () => {
  for (const [between, folded] of [[2, true], [3, false]] as const) {
    const teardown = setup();
    try {
      const mine = Array.from({ length: between }, (_, index) => `[19/11/2026, 20:17:0${index}] أنا: رسالة رقم ${index + 1} عن الطقس`);
      const chat = [`[19/11/2026, 20:16:42] سامي: ${REQUEST}`, ...mine, '[19/11/2026, 20:18:00] أنا: تمام 👍'].join('\n');
      const last = between + 1;
      const result = await shareFile(chat, { generateStructured: selection(() => [last]).generate });
      const excerpts = result.share.evidence.map((entry) => entry.excerpt);
      assert.equal(result.share.metrics.messagesChosen, 1, `between ${between}`);
      if (folded) assert.ok(excerpts.length === 0 || excerpts.includes(REQUEST), `between ${between}: ${JSON.stringify(excerpts)}`);
      assert.equal(meeting(result.items) !== undefined, folded, `between ${between}: ${JSON.stringify(result.items.map((item) => item.title))}`);
    } finally {
      teardown();
    }
  }
});

test('review 7 (M11): an acceptance answering an acceptance brings nothing in', async () => {
  const teardown = setup();
  try {
    const chat = [
      `[19/11/2026, 20:16:00] أنا: ${REQUEST}`,
      '[19/11/2026, 20:16:42] سامي: تمام',
      '[19/11/2026, 20:17:05] أنا: أكيد 👍',
    ].join('\n');
    const result = await shareFile(chat, { generateStructured: selection(() => [2]).generate });
    assert.equal(result.share.metrics.messagesChosen, 1);
    assert.equal(meeting(result.items), undefined);
  } finally {
    teardown();
  }
});

test('review 7 (M14): an acceptance is looked for in the first 200 characters only', () => {
  assert.equal(acceptanceReply(`${' '.repeat(250)}تمام`), null);
  assert.equal(acceptanceReply(`تمام ${'ب'.repeat(300)} لأ`), 'opens');
});

test('review 6 + M19: «لا تنسى إنه …» loses «إنه»; "don\'t forget to" alone is not "to"; only at the start', () => {
  const context = { now: new Date(REFERENCE_TIME), timezone: ZONE };
  for (const text of ['لا تنسى إنه تدفع الفاتورة بكرا', 'لا تنسى انه تدفع الفاتورة بكرا', 'لا تنسى أن تدفع الفاتورة بكرا', 'لا تنسى إن تدفع الفاتورة بكرا']) {
    assert.equal(extract(text, context).title, 'تدفع الفاتورة', text);
  }
  assert.notEqual(extract("Don't forget to", context).title, 'to');
  assert.match(extract('اجتماع الفريق لا تنسى العرض بكرا', context).title ?? '', /لا تنسى/);
});

test('mutation: a kind "no" after other words is still a yes; a refusal past six words is not read; «وما» refuses', () => {
  assert.equal(acceptanceReply("sure, and don't worry"), 'opens');
  assert.equal(acceptanceReply('تمام وما تقلق'), 'opens');
  assert.equal(acceptanceReply('أكيد بجيب العرض والكمبيوتر والشاحن والدفتر وبعدين ما بنسى'), 'opens');
  assert.equal(acceptanceReply('تمام وما رح أقدر'), null);
});

/* ── review round 2 (2026-11-20): a "no" inside a yes is not a refusal ── */

/** Yes, with a negation word inside it: none of these takes the yes back. */
const STILL_YES = [
  'تمام ما بنسى',
  'أكيد وما بنسى',
  'تمام ما رح أنسى',
  'تمام بكرا الساعة 5 ما بنسى',
  "sure, I won't forget",
  'ok I will not forget',
  "ok I don't mind",
  'ok لا مشكلة',
  'تمام ما عندي مشكلة',
  "sure, I can't wait",
  'yes, never fear',
  "ok, I'll be there no matter what",
  'sure, no doubt',
  'تمام انا موجود ما حدا غيري',
  'أكيد، لا أحد غيري بيقدر',
  'لا تقلق رح أجي',
  'أكيد، ما في مشكلة',
  'sure, no problem',
  'ok, no worries',
  'אין בעיה',
  'تمام ولا يهمك',
  'ברור שלא אשכח',
  '👌',
  '✅',
];

/** A yes taken back, or no yes at all. */
const REFUSED = [
  'أكيد لأ',
  'أكيد لا',
  'أكيد، لا والله',
  'تمام بس مش رح أقدر',
  'تمام بس مش فاضي',
  'مش متأكد بس تمام',
  'تمام وما رح أقدر',
  'أكيد ما بقدر',
  'تمام بس ما بلحق',
  'أكيد مستحيل',
  'تمام بلاش',
  'sure, no',
  'sure no.',
  "ok but I can't",
  "okay, I won't make it",
  'ok, not sure',
  'ברור שלא',
  'בטח שלא',
  'בטח אני לא יכול',
  'בסדר, לא אוכל',
  '👍👎',
  'sure 👎',
  '👎',
  '😂',
  '🙂',
];

test('review 2 (40+ cases): a negation word alone never takes a yes back', () => {
  for (const yes of STILL_YES) assert.notEqual(acceptanceReply(yes), null, yes);
});

test('review 2 (40+ cases): an explicit refusal, 👎, or a face that says nothing is no acceptance', () => {
  for (const no of REFUSED) assert.equal(acceptanceReply(no), null, no);
});

test('review 2: «لا تنسى …» answered «أكيد وما بنسى» brings the reminder in — the original defect', async () => {
  const teardown = setup();
  try {
    const chat = [
      `[19/11/2026, 20:16:42] سامي: ${REQUEST}`,
      '[19/11/2026, 20:17:05] أنا: أكيد وما بنسى 👍',
    ].join('\n');
    const result = await shareFile(chat, { generateStructured: selection(() => [1]).generate });
    assert.equal(meeting(result.items)?.resolvedTime, SUNDAY_11);
  } finally {
    teardown();
  }
});

test('review 3 (d) + D19: "don\'t forget about/that …" lose their joiner; a joiner alone or before a mark stays', () => {
  const context = { now: new Date(REFERENCE_TIME), timezone: ZONE };
  assert.equal(extract("don't forget about the meeting", context).title, 'the meeting');
  assert.equal(extract("don't forget that I have dentist", context).title, 'I have dentist');
  assert.notEqual(extract("Don't forget to!", context).title, 'to!');
  assert.notEqual(extract("Don't forget to!", context).title, 'to');
  // A day taken off the end leaves the joiner last: it is not stripped to nothing.
  assert.match(extract('لا تنسى إنه بكرا', context).title ?? '', /تنسى/);
  assert.match(extract("don't forget to tomorrow", context).title ?? '', /forget/i);
});

test('mutation D19: «لا تنسى إنه» with a day taken off its end keeps its words; «لا تنسى إنه تدفع» loses them', () => {
  const context = { now: new Date(REFERENCE_TIME), timezone: ZONE };
  assert.notEqual(extract('لا تنسى إنه بكرا', context).title ?? '', '');
  assert.notEqual(extract('لا تنسى أن بكرا', context).title ?? '', '');
});

test('mutation D2/D19: a joiner before a mark, after a space, stays — the title is never the mark alone', () => {
  const context = { now: new Date(REFERENCE_TIME), timezone: ZONE };
  assert.notEqual(extract("Don't forget to !", context).title, '!');
  assert.notEqual(extract('لا تنسى إنه !', context).title, '!');
  assert.notEqual(extract('لا تنسى !', context).title, '!');
});
