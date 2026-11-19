/**
 * QA v3 V3-F26-01 (#806 part 1, still present): the memory summary answered
 * `unavailable` as soon as one fact held a digit («عندي 3 محاضرات»), a weekday
 * («كل أحد وثلاثاء») or a number word («العاشرة»), and the refused answer was
 * still charged to the memory add-on (memory_learning 0 → 4–6 %).
 *
 * The validator compared the *spelling* of a number, not its value: «تلات»
 * beside a row that says 3, "10" beside a row that says «العاشرة», «٣» beside
 * 3, and the Levantine weekday «التلات» beside a row that says «ثلاثاء» were
 * all read as inventions. A number is still refused when no cited row holds
 * that value — the summary may say what a row says, never more.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addRows, begin, end, scriptedModel, show, summary, useSummaryModel } from '../acceptance/m5b/support.ts';
import { validateMemorySummary, type MemorySummaryLanguage } from '../../lib/services/mobile/memorySummary.ts';
import { readMonthSpend } from '../../lib/features/spendLedger.ts';

const one = (text: string, row: string, language: MemorySummaryLanguage = 'ar') =>
  validateMemorySummary({ sentences: [{ text, refs: ['r1'] }] }, [{ ref: 'r1', id: 'x', kind: 'fact', text: row }], language);

test('a digit in the row may be said back as a word; another number is still refused', () => {
  const row = 'عندي 3 محاضرات بالأسبوع';
  assert.notEqual(one('عندك 3 محاضرات بالأسبوع.', row), null);
  assert.notEqual(one('عندك تلات محاضرات بالأسبوع.', row), null);
  // M5B-031 and R1.1 stand: a sentence's digits are Latin and copied whole.
  assert.equal(one('عندك ٣ محاضرات بالأسبوع.', row), null);
  assert.equal(one('Focus from 9:00 on.', 'Focus 09:00-12:00', 'en'), null);
  // The person typed Arabic-Indic digits: the sentence may say that number in Latin digits or in words.
  assert.notEqual(one('عندك 3 محاضرات بالأسبوع.', 'عندي ٣ محاضرات بالأسبوع'), null);
  assert.notEqual(one('عندك تلات محاضرات بالأسبوع.', 'عندي ٣ محاضرات بالأسبوع'), null);
  assert.notEqual(one('You have three lectures a week.', row, 'en'), null);
  assert.equal(one('عندك 4 محاضرات بالأسبوع.', row), null);
  assert.equal(one('عندك ٤ محاضرات بالأسبوع.', row), null);
  assert.equal(one('عندك أربع محاضرات بالأسبوع.', row), null);
  assert.equal(one('You have four lectures a week.', row, 'en'), null);
});

test('a number word in the row may be said back as digits; another hour is still refused', () => {
  const row = 'بنام الساعة العاشرة';
  assert.notEqual(one('بتنام الساعة العاشرة.', row), null);
  assert.notEqual(one('بتنام الساعة 10.', row), null);
  assert.notEqual(one('بتنام الساعة عشرة.', row), null);
  assert.notEqual(one('You go to sleep at 10.', row, 'en'), null);
  assert.equal(one('بتنام الساعة 11.', row), null);
  assert.equal(one('بتنام الساعة حداش.', row), null);
  assert.equal(one('You go to sleep at eleven.', row, 'en'), null);
});

test('weekdays the row names without «ال» pass in their Levantine forms; a day or a number it does not name is refused', () => {
  const row = 'بروح عالجيم كل أحد وثلاثاء';
  assert.notEqual(one('بتروح عالجيم كل أحد وثلاثاء.', row), null);
  assert.notEqual(one('بتروح عالجيم كل أحد وتلات.', row), null);
  assert.notEqual(one('بتروح عالجيم يوم الأحد والتلات.', row), null);
  assert.notEqual(one('You go to the gym every Sunday and Tuesday.', row, 'en'), null);
  assert.equal(one('بتروح عالجيم يوم الأحد والاتنين.', row), null);
  assert.equal(one('بتروح عالجيم تلات مرات.', row), null);
  // «التلات» beside no weekday and no 3 is "the three", an invention.
  assert.equal(one('عندك التلات ولاد.', 'عندي ولاد بالمدرسة'), null);
});

async function withGate<T>(mode: 'shadow' | 'enforce', run: () => Promise<T>): Promise<T> {
  const previous = process.env.MAYBESITTER_ADDON_GATE_MODE;
  const [warn, error] = [console.warn, console.error];
  process.env.MAYBESITTER_ADDON_GATE_MODE = mode;
  console.warn = () => {};
  console.error = () => {};
  try { return await run(); } finally {
    console.warn = warn;
    console.error = error;
    if (previous === undefined) delete process.env.MAYBESITTER_ADDON_GATE_MODE;
    else process.env.MAYBESITTER_ADDON_GATE_MODE = previous;
  }
}

const spent = async (uid: string) => {
  const month = await readMonthSpend(uid);
  return { feature: month.features.memory_learning ?? 0, holds: Object.keys(month.holds ?? {}).length };
};

for (const mode of ['shadow', 'enforce'] as const) {
  test(`${mode}: a refused answer charges the memory add-on nothing; a ready one is charged`, async () => {
    try {
      await withGate(mode, async () => {
        const uid = await begin();
        await addRows(uid, [{ content: 'عندي 3 محاضرات بالأسبوع', language: 'ar' }]);
        const invented = scriptedModel(() => ({ sentences: [{ text: 'عندك 5 محاضرات بالأسبوع.', refs: ['r1'] }] }));
        await useSummaryModel(invented);
        const refused = await summary(uid, 'ar');
        assert.equal(refused.body.summary?.status, 'unavailable', show(refused.body));
        assert.equal(invented.calls.length, 1);
        assert.deepEqual(await spent(uid), { feature: 0, holds: 0 }, 'an unavailable summary was charged');

        const honest = scriptedModel(() => ({ sentences: [{ text: 'عندك تلات محاضرات بالأسبوع.', refs: ['r1'] }] }));
        await useSummaryModel(honest);
        const ready = await summary(uid, 'ar');
        assert.equal(ready.body.summary?.status, 'ready', show(ready.body));
        const after = await spent(uid);
        assert.ok(after.feature > 0, 'a ready summary was not charged');
        assert.equal(after.holds, 0);
      });
    } finally { end(); }
  });
}
