/**
 * A clause that is only a time is not a commitment (FINAL-BACKEND review).
 *
 * The splitter cuts at every «،» (and «;»), so «بدي أتصل بسامي، بكرا» became
 * two items: «أتصل بسامي» with no day, and «بكرا» asking what to do. Same for
 * «، ومش بكرا», «، الساعة 5», "; tomorrow at 5". A clause with nothing of its
 * own — only day, time and part-of-day words, their negation or alternatives,
 * and connectors — is merged back into the clause before it, before any
 * extraction; a leading one into the clause after it. Both engines read the
 * same segments (`splitCaptureClauses` feeds the rules and the model alike),
 * so both see one clause. Genuine multi-item captures still split.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCaptureClauses } from '../../src/extraction/clauseSplitter.ts';
import { MemoryCaptureProposalStore, proposeCapture, TransactionalCapturePersistenceAdapter } from '../../lib/services/captureBoundary/index.ts';
import { guardedMobileExtract } from '../../lib/services/mobile/safety.ts';
import { proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';

const TZ = 'Asia/Jerusalem';
/** Monday 28 Sep 2026, 10:05 in Jerusalem. */
const NOW = new Date('2026-09-28T07:05:00.000Z');

const CASES: ReadonlyArray<{ text: string; clauses: string[]; rules: string[] }> = [
  { text: 'بدي أتصل بسامي، بكرا', clauses: ['بدي أتصل بسامي بكرا'], rules: ['أتصل بسامي | 2026-09-29'] },
  { text: 'بدي أتصل بسامي، ومش بكرا', clauses: ['بدي أتصل بسامي ومش بكرا'], rules: ['أتصل بسامي ومش بكرا | -'] },
  { text: 'أتصل بسامي، الساعة 5', clauses: ['أتصل بسامي الساعة 5'], rules: ['أتصل بسامي | 2026-09-28'] },
  { text: 'call Sam; tomorrow at 5', clauses: ['call Sam tomorrow at 5'], rules: ['call Sam | 2026-09-29'] },
  { text: 'بكرا، بدي أتصل بسامي', clauses: ['بكرا بدي أتصل بسامي'], rules: ['أتصل بسامي | 2026-09-29'] },
];

const ALREADY_ONE: readonly string[] = ['call Sam, tomorrow at 5', 'להתקשר לסאמי, מחר'];

test('the splitter merges a time-only clause into the one before it, or a leading one into the next', () => {
  for (const { text, clauses } of CASES) {
    assert.deepEqual(splitCaptureClauses(text), clauses, text);
  }
  // A comma in English or Hebrew never split; still one clause.
  for (const text of ALREADY_ONE) assert.deepEqual(splitCaptureClauses(text), [text], text);
});

test('a clause with content of its own is never merged, whatever time words it has', () => {
  assert.deepEqual(splitCaptureClauses('call Sam; buy bread tomorrow'), ['call Sam', 'buy bread tomorrow']);
  assert.deepEqual(
    splitCaptureClauses('بدي أتصل بسامي، وبكرا بدي أروح عالسوق'),
    ['بدي أتصل بسامي', 'وبكرا بدي أروح عالسوق'],
  );
  assert.deepEqual(
    splitCaptureClauses('اليوم الساعة 3 العصر كان عندي اجتماع مع سامي، واليوم لازم أرتب الغرفة، وبكرا الساعة 5 بدي أروح عالبنك'),
    ['اليوم الساعة 3 العصر كان عندي اجتماع مع سامي', 'واليوم لازم أرتب الغرفة', 'وبكرا الساعة 5 بدي أروح عالبنك'],
  );
});

type Item = { title: string; resolvedDate?: string };
const line = (item: Item) => `${item.title} | ${item.resolvedDate ?? '-'}`;

test('rules path: each literal input is one item with its day', async () => {
  for (const { text, rules } of CASES) {
    setStorageForTests(createMemoryStorage());
    try {
      const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() });
      assert.deepEqual(proposal.items.map(line), rules, text);
    } finally {
      resetStorageForTests();
    }
  }
});

test('model path: each literal input reaches the model as one clause, and is one item', async () => {
  for (const { text, clauses } of CASES) {
    const sent: unknown[] = [];
    const provider = async (prompt: string): Promise<string> => {
      const lines = prompt.split('\n');
      const payload = JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
      sent.push(payload);
      const answer = (clause: string) => ({
        type: 'task', action: 'أتصل بسامي', title: 'أتصل بسامي', person: null, dueAt: null, remindAt: null, localTimeSpec: null,
        priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
        flexibility: 'movable', category: null, categoryConfidence: 0,
        confidence: { overall: 0.9, type: 1, action: 0.9, time: 0.3, priority: 1 },
        missingFields: ['time'], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false, _clause: clause,
      });
      return Array.isArray(payload)
        ? JSON.stringify({ items: payload.map((clause, clauseIndex) => ({ clauseIndex, ...answer(clause) })) })
        : JSON.stringify(answer(payload));
    };
    const contract = await proposeCapture(
      text,
      { now: NOW, timezone: TZ, scopeId: 'merge', requestedEngine: 'model' },
      {
        store: new MemoryCaptureProposalStore(),
        persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
        extractor: guardedMobileExtract,
        llmProvider: provider,
        llmEngine: 'gemini',
      },
    );
    assert.deepEqual(sent, clauses.length === 1 ? [clauses[0]] : [clauses], text);
    assert.equal(contract.items.length, 1, `${text}: ${JSON.stringify(contract.items.map((item) => item.title))}`);
  }
});
