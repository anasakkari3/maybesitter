/**
 * The final UAT's capture defect N19 (Monday 28 Sep 2026, 10:04, Gemini path
 * consented): «سجّل موعد دكتور اليوم» reached the review card as «موعد دكتور ·
 * بدون وقت» with «أي وقت بناسبك؟» — no day — while «عندي موعد دكتور اليوم»,
 * a minute later, kept «اليوم».
 *
 * Root cause: not the imperative. «سجّل» is taken off the title only
 * (`stripCaptureCommand`), and the rules path keeps the day for every probe
 * below. On the model path the day is the model's: the validator fills an
 * absent one from the words only for a weekday (CL1 round 1, «سجّل موعد دكتور
 * يوم الأحد» with `localTimeSpec: null`) and for this month's end, never for
 * «اليوم»/«بكرا»/"today"/«היום». So a Gemini answer with no day lost the day
 * the person said. Gemini does drop it: its recorded round-2 answer for
 * «واليوم لازم أرتب الغرفة» (`fixtures/uat-2026-09-27-round2-gemini.json`)
 * has no day, and `fy1CaptureRegressions` pinned that lost day until this
 * fix. The UAT's own N19 answer was not recorded; the server log has
 * that call at 07:04:05Z answering in 131 output tokens against 175–182 for
 * every other single-clause capture of the run — the size of an answer with
 * `dueAt` and `localTimeSpec` both null. Re-asked live on the fix morning,
 * Gemini gave the day for both sentences (`fixtures/uat-2026-09-28-final-
 * gemini.json`, replayed below): it is the model's variance, and the words
 * have to hold the day when the model drops it.
 *
 * Rows that script a model answer say so; the recorded rows never do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LLMUnavailableError } from '../../src/extraction/llm/llmProvider.ts';
import {
  answerClarification,
  confirmCapture,
  MemoryCaptureProposalStore,
  proposeCapture,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import { guardedMobileExtract } from '../../lib/services/mobile/safety.ts';
import { proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';

const TZ = 'Asia/Jerusalem';
/** Monday 28 Sep 2026, 10:05 in Jerusalem. */
const NOW = new Date('2026-09-28T07:05:00.000Z');
const TODAY = '2026-09-28';
const TOMORROW = '2026-09-29';

const CALLS = (JSON.parse(readFileSync(new URL('./fixtures/uat-2026-09-28-final-gemini.json', import.meta.url), 'utf8')) as {
  calls: Array<{ case: string; payload: string | string[]; answer: Record<string, unknown> }>;
}).calls;

function payloadOf(prompt: string): string | string[] {
  const lines = prompt.split('\n');
  return JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
}

/** Gemini's recording for the payload; anything else is a failed call. */
async function recorded(prompt: string): Promise<string> {
  const payload = payloadOf(prompt);
  const hit = CALLS.find((call) => JSON.stringify(call.payload) === JSON.stringify(payload));
  if (hit) return JSON.stringify(hit.answer);
  throw new LLMUnavailableError('provider_error');
}

/**
 * SCRIPTED: Gemini's recorded «سجّل موعد دكتور اليوم» answer with the day
 * taken out — `dueAt`, `remindAt` and `localTimeSpec` null, `time` missing —
 * the shape the UAT's short answer had. The title is the clause's own.
 */
function noDayModel(title: string) {
  const base = CALLS.find((call) => call.case === 'FINAL N19 log a doctor today')!.answer;
  const answer = {
    ...base, action: title, title, dueAt: null, remindAt: null, localTimeSpec: null,
    missingFields: ['time'], ambiguityFlags: [],
  };
  return async (prompt: string): Promise<string> => {
    const payload = payloadOf(prompt);
    return Array.isArray(payload)
      ? JSON.stringify({ items: payload.map((_, clauseIndex) => ({ clauseIndex, ...answer })) })
      : JSON.stringify(answer);
  };
}

async function proposeModel(text: string, provider: (prompt: string) => Promise<string>) {
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const contract = await proposeCapture(
    text,
    { now: NOW, timezone: TZ, scopeId: 'n19', requestedEngine: 'model' },
    { store, persistence, extractor: guardedMobileExtract, llmProvider: provider, llmEngine: 'gemini' },
  );
  return { contract, store, persistence };
}

type Item = { title: string; resolvedDate?: string; resolvedTime: string | null; clarification?: { questionKey?: string; params?: { date?: string } } | null };
/** What the card and the question show: the day, the hour, and the day the question names. */
const shown = (item: Item) => [item.resolvedDate ?? null, item.resolvedTime, item.clarification?.questionKey ?? null, item.clarification?.params?.date ?? null];

const PROBES: ReadonlyArray<{ text: string; title: string; day: string }> = [
  { text: 'سجّل موعد دكتور اليوم', title: 'موعد دكتور', day: TODAY },
  { text: 'عندي موعد دكتور اليوم', title: 'عندي موعد دكتور', day: TODAY },
  { text: 'سجّل موعد أسنان بكرا', title: 'موعد أسنان', day: TOMORROW },
  { text: 'سجّل اجتماع اليوم', title: 'اجتماع', day: TODAY },
  { text: 'ذكّرني اليوم أتصل بأمي', title: 'أتصل بأمي', day: TODAY },
  { text: 'log a doctor appointment today', title: 'doctor appointment', day: TODAY },
  { text: 'תרשום תור לרופא היום', title: 'תור לרופא', day: TODAY },
];

test('N19 recorded: Gemini\'s answers on the fix morning keep «اليوم» for both sentences, the hour asked on that day', async () => {
  for (const text of ['سجّل موعد دكتور اليوم', 'عندي موعد دكتور اليوم']) {
    const { contract } = await proposeModel(text, recorded);
    assert.equal(contract.provenance.executedEngine, 'gemini', text);
    assert.equal(contract.items.length, 1, text);
    assert.deepEqual(shown(contract.items[0]!), [TODAY, null, 'ask_time', TODAY], text);
  }
});

for (const probe of PROBES) {
  test(`N19 model path (SCRIPTED no-day answer): «${probe.text}» keeps its day, and the question names it`, async () => {
    const { contract } = await proposeModel(probe.text, noDayModel(probe.title));
    assert.equal(contract.provenance.executedEngine, 'gemini');
    assert.equal(contract.items.length, 1);
    assert.deepEqual(shown(contract.items[0]!), [probe.day, null, 'ask_time', probe.day]);
    // Said, not guessed: the card does not mark «اليوم» as an estimate.
    assert.equal((contract.items[0] as { dateEstimated?: boolean }).dateEstimated, false);
  });

  test(`N19 rules path: «${probe.text}» keeps its day, and the question names it`, async () => {
    setStorageForTests(createMemoryStorage());
    try {
      const proposal = await proposeMobileCapture({ text: probe.text, timezone: TZ, referenceTime: NOW.toISOString() });
      assert.equal(proposal.items.length, 1);
      assert.deepEqual(shown(proposal.items[0]!), [probe.day, null, 'ask_time', probe.day]);
    } finally {
      resetStorageForTests();
    }
  });
}

test('N19 × N18: the model\'s no-day «سجّل موعد دكتور اليوم» answered «بدون وقت محدد» is an all-day appointment today', async () => {
  const { contract, store, persistence } = await proposeModel('سجّل موعد دكتور اليوم', noDayModel('موعد دكتور'));
  const item = contract.items[0]!;
  const none = item.clarification!.options.find((option) => !option.value.localTime && !option.value.localDate)!;
  await answerClarification(
    { proposalId: contract.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: none.optionId },
    { now: NOW, timezone: TZ, scopeId: 'n19' },
    { store, recordEvent: () => undefined },
  );
  const confirmed = await confirmCapture(
    { proposalId: contract.proposalId, scopeId: 'n19', selectedItemIds: [item.itemId], idempotencyKey: 'k-n19', now: NOW },
    { store, persistence },
  );
  assert.equal(confirmed.success, true, JSON.stringify(confirmed));
  const [saved] = Object.values((await persistence.snapshot()).commitments);
  assert.deepEqual(
    [saved!.timeSpec.kind, saved!.timeSpec.allDay, saved!.timeSpec.dueAt],
    ['scheduled_event', true, '2026-09-27T21:00:00.000Z'],
  );
});

test('N19 guard (SCRIPTED): words that put it on another day than today get no «today» from the fill', async () => {
  // «مش اليوم» / "not today": the words name today only to rule it out.
  for (const text of ['بدي أتصل بسامي بس مش اليوم', 'call Sam, but not today']) {
    const { contract } = await proposeModel(text, noDayModel('أتصل بسامي'));
    assert.equal(contract.items[0]?.resolvedDate ?? null, null, text);
  }
});

test('N19 guard (SCRIPTED, review M2): a day ruled out or left open gets no fill — the item is asked with no day', async () => {
  const texts = [
    'بدي أتصل بسامي بس مش بكرا',
    'بدي أتصل بسامي، ومش بكرا',
    'call Sam, but not tomorrow',
    'להתקשר לסאמי אבל לא מחר',
    'اليوم أو بكرا بدي أتصل بسامي',
    'اليوم ولا بكرا بدي أتصل بسامي',
    'call Sam today or tomorrow',
    'להתקשר לסאמי היום או מחר',
  ];
  for (const text of texts) {
    const { contract } = await proposeModel(text, noDayModel('أتصل بسامي'));
    const item = contract.items[0]!;
    assert.deepEqual([item.resolvedDate ?? null, item.resolvedTime, item.needsClarification], [null, null, true], text);
    // The rules path reads the same words the same way: no day, asked.
    setStorageForTests(createMemoryStorage());
    try {
      const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() });
      const rules = proposal.items[0]!;
      assert.deepEqual([rules.resolvedDate ?? null, rules.resolvedTime, rules.needsClarification], [null, null, true], `rules: ${text}`);
    } finally {
      resetStorageForTests();
    }
  }
});

test('N19 guard (review M2): the plain day words still fill beside the guard', async () => {
  // Not a negation or an alternative: «بكرا» alone, and "or" between two
  // people rather than two days.
  for (const [text, day] of [
    ['بدي أتصل بسامي بكرا', TOMORROW],
    ['call Sam or Rami tomorrow', TOMORROW],
    ['להתקשר לסאמי מחר', TOMORROW],
  ] as const) {
    const { contract } = await proposeModel(text, noDayModel('أتصل بسامي'));
    assert.equal(contract.items[0]?.resolvedDate, day, text);
  }
});

test('N19 guard (SCRIPTED): a model day is never moved — only an absent one is filled', async () => {
  // L4 ruling: the fill is for a missing day. A model that read a day keeps
  // it here, even beside «اليوم» (a model *tomorrow* under «اليوم» is FZ1's
  // own narrow move, not this fill's).
  const base = CALLS.find((call) => call.case === 'FINAL N19 log a doctor today')!.answer;
  const answer = { ...base, dueAt: null, remindAt: null, localTimeSpec: { date: '2026-09-30', time: null, timezone: TZ } };
  const { contract } = await proposeModel('سجّل موعد دكتور اليوم', async () => JSON.stringify(answer));
  assert.equal(contract.items[0]?.resolvedDate, '2026-09-30');
});
