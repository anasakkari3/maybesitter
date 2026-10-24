/**
 * The memory summary against what real Gemini did (live run, 2026-10-24):
 * both languages came back `unavailable`. The routine survey's machine rows
 * («quiet_hours:22:30-07:00») were sent and no sentence could cite them, and
 * the prompt said both "Requested language: en" and "write in the language of
 * the observations" — an English request got Arabic, an Arabic one dropped
 * every English row. The validator was right both times; the input and the
 * instructions were not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addRows, begin, end, promptOf, scriptedModel, show, summary, useSummaryModel } from '../acceptance/m5b/support.ts';

test.afterEach(() => end());

test('routine survey rows are not sent: one prose row cited is a ready summary, the routine row still counted', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: 'Likes tea in the morning.' }, { content: 'quiet_hours:22:30-07:00', language: 'mixed', kind: 'preference' }]);
  const model = scriptedModel(() => ({ sentences: [{ text: 'You like tea in the morning.', refs: ['r1'] }] }));
  await useSummaryModel(model);
  const answer = await summary(uid, 'en');
  assert.equal(answer.status, 200, show(answer.body));
  assert.equal(answer.body.summary?.status, 'ready', show(answer.body));
  assert.equal(answer.body.summary.coveredCount, 1);
  assert.equal(answer.body.summary.totalCount, 2);
  assert.equal(model.calls.length, 1);
  assert.ok(!promptOf(model.calls[0]!.request).includes('quiet_hours'));
});

test('only routine survey rows: empty, and no model call', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: 'quiet_hours:22:30-07:00', language: 'mixed', kind: 'preference' }, { content: 'sleep_window:23:30-07:00', language: 'mixed', kind: 'preference' }]);
  const model = scriptedModel(() => ({ sentences: [] }));
  await useSummaryModel(model);
  const answer = await summary(uid, 'en');
  assert.deepEqual(answer.body, { success: true, summary: { status: 'empty' } });
  assert.equal(model.calls.length, 0);
});

test('the prompt names the asked language, says to translate, and never "the language of the observations"', async () => {
  const prompts: Record<string, string> = {};
  for (const language of ['en', 'ar', 'he'] as const) {
    const uid = await begin();
    await addRows(uid, [{ content: 'بحب امشي الصبح', language: 'ar' }]);
    const model = scriptedModel(() => ({ sentences: [] }));
    await useSummaryModel(model);
    await summary(uid, language);
    prompts[language] = promptOf(model.calls[0]!.request);
    end();
  }
  assert.match(prompts.en!, /Write every sentence in English, even for a row written in another language: translate it\./);
  assert.match(prompts.ar!, /Write every sentence in spoken, everyday Levantine Arabic/);
  assert.match(prompts.he!, /Write every sentence in everyday Hebrew/);
  for (const prompt of Object.values(prompts)) {
    assert.ok(!prompt.includes('language of the observations'), prompt);
    assert.match(prompt, /never write r1 or \(r1\) in a sentence/);
  }
  assert.match(prompts.ar!, /عندك not لديك/);
  assert.ok(!prompts.en!.includes('عندك not لديك'));
  assert.ok(!prompts.he!.includes('عندك not لديك'));
});

// #806 part 1: «الاثنين» (Monday) read as «اثنين» (two); the Hebrew days after
// «יום» are the ordinals. A weekday only where a cited row names that day.
test('a weekday that reads as a number passes where the cited row names that day, and is still a number where none does', async () => {
  const { validateMemorySummary } = await import('../../lib/services/mobile/memorySummary.ts');
  const gym = { ref: 'r1', id: 'a', kind: 'fact', text: 'I go to the gym on Mondays and Wednesdays at 19:00' };
  const kids = { ref: 'r1', id: 'b', kind: 'fact', text: 'عندي ولاد بالمدرسة' };
  const one = (text: string, row: typeof gym, language: 'ar' | 'he') => validateMemorySummary({ sentences: [{ text, refs: ['r1'] }] }, [row], language);
  assert.notEqual(one('بتروح عالجيم أيام الاثنين والأربعاء الساعة 19:00.', gym, 'ar'), null);
  assert.notEqual(one('אתה הולך לחדר כושר ביום שני וביום רביעי ב-19:00.', gym, 'he'), null);
  assert.equal(one('عندك الاثنين بالمدرسة.', kids, 'ar'), null);
  assert.equal(one('יש לך שני ילדים בבית ספר.', kids, 'he'), null);
});

// Live Gemini, 2026-10-24: "two children" translating «عندي ولدين» (a dual) was
// refused as an invented number, so the English summary never showed.
test('"two" translating an Arabic dual passes in English and Hebrew; an invented "two" still fails', async () => {
  const { validateMemorySummary } = await import('../../lib/services/mobile/memorySummary.ts');
  const kids = { ref: 'r1', id: 'b', kind: 'fact', text: 'عندي ولدين بالمدرسة' };
  const work = { ref: 'r1', id: 'c', kind: 'fact', text: 'بشتغل بشركة صغيرة' };
  const one = (text: string, row: typeof kids, language: 'en' | 'he' | 'ar') => validateMemorySummary({ sentences: [{ text, refs: ['r1'] }] }, [row], language);
  assert.notEqual(one('You have two children in school.', kids, 'en'), null);
  assert.notEqual(one('יש לך שני ילדים בבית הספר.', kids, 'he'), null);
  assert.equal(one('You work at two small companies.', work, 'en'), null);
  assert.equal(one('You have three children in school.', kids, 'en'), null);
});

test('the prompt asks for "you", never "the user"', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: 'Likes tea.' }]);
  const model = scriptedModel(() => ({ sentences: [] }));
  await useSummaryModel(model);
  await summary(uid, 'en');
  assert.match(promptOf(model.calls[0]!.request), /Speak to the person directly, as "you"/);
});
