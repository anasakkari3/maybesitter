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
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';

/** The routine survey's own rows, written the way onboarding writes them. */
async function surveyRows(uid: string): Promise<void> {
  await saveRoutineProfile(uid, {
    timezone: 'Asia/Jerusalem', sleepWindow: { start: '23:30', end: '07:30' }, focusWindows: [],
    fixedCommitmentWindows: [], preferredReminderIntensity: 'softAwareness',
    quietHours: { start: '22:30', end: '07:30' }, surveySkipped: false,
  }, new Date().toISOString());
}

test.afterEach(() => end());

test('routine survey rows are not sent: one prose row cited is a ready summary, the routine row still counted', async () => {
  const uid = await begin();
  await surveyRows(uid);
  await addRows(uid, [{ content: 'Likes tea in the morning.' }]);
  const model = scriptedModel(() => ({ sentences: [{ text: 'You like tea in the morning.', refs: ['r1'] }] }));
  await useSummaryModel(model);
  const answer = await summary(uid, 'en');
  assert.equal(answer.status, 200, show(answer.body));
  assert.equal(answer.body.summary?.status, 'ready', show(answer.body));
  assert.equal(answer.body.summary.coveredCount, 1);
  assert.ok(answer.body.summary.totalCount > 1);
  assert.equal(model.calls.length, 1);
  assert.ok(!promptOf(model.calls[0]!.request).includes('quiet_hours'));
});

test('only routine survey rows: empty, and no model call', async () => {
  const uid = await begin();
  await surveyRows(uid);
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

// Inspection MS-ROUTINE-004: a note the person typed is theirs to have
// summarized, even when it starts like a survey row.
test('a manual note that starts like a survey row is still summarized', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: 'quiet_hours:I cannot take calls overnight' }]);
  const model = scriptedModel(() => ({ sentences: [{ text: 'You cannot take calls overnight.', refs: ['r1'] }] }));
  await useSummaryModel(model);
  const answer = await summary(uid, 'en');
  assert.equal(answer.body.summary?.status, 'ready', show(answer.body));
  assert.ok(promptOf(model.calls[0]!.request).includes('I cannot take calls overnight'));
});

// Inspection MS-DUAL-001: the -ين ending alone is no dual.
test('"two" needs a listed dual noun in a cited row: a plural or a name ending in -ين does not count', async () => {
  const { validateMemorySummary } = await import('../../lib/services/mobile/memorySummary.ts');
  const one = (text: string, row: string) => validateMemorySummary({ sentences: [{ text, refs: ['r1'] }] }, [{ ref: 'r1', id: 'x', kind: 'fact', text: row }], 'en');
  assert.equal(one('You work with two engineers.', 'بشتغل مع مهندسين'), null);
  assert.equal(one('You have two friends in Palestine.', 'عندي صحاب بفلسطين'), null);
  assert.notEqual(one('You have two daughters.', 'عندي بنتين'), null);
});

// Inspection MS-DUAL-007: the dual unlocks only its own noun.
test('a dual in the row unlocks "two" only before its own noun, never an invented count beside it', async () => {
  const { validateMemorySummary } = await import('../../lib/services/mobile/memorySummary.ts');
  const row = [{ ref: 'r1', id: 'x', kind: 'fact', text: 'عندي ولدين وبشتغل بشركة صغيرة' }];
  const one = (text: string, language: 'en' | 'he') => validateMemorySummary({ sentences: [{ text, refs: ['r1'] }] }, row, language);
  assert.notEqual(one('You have two children and work at a small company.', 'en'), null);
  assert.equal(one('You have children and work at two companies.', 'en'), null);
  assert.notEqual(one('יש לך שני ילדים ואתה עובד בחברה קטנה.', 'he'), null);
  assert.equal(one('יש לך ילדים ואתה עובד בשתי חברות.', 'he'), null);
});

// Inspection MS-ROUTINE-008: a survey row the person edited into words is theirs.
test('a survey row edited into prose is summarized; the untouched machine rows are not', async () => {
  const uid = await begin();
  await surveyRows(uid);
  const { listMemory, patchMemory } = await import('../../lib/services/mobile/memoryService.ts');
  const listed = await listMemory(uid, new Date().toISOString());
  const quiet = listed.find((row) => row.content.startsWith('quiet_hours:'))!;
  await patchMemory(uid, quiet.id, 'quiet_hours:I cannot take calls overnight', new Date().toISOString());
  const model = scriptedModel(() => ({ sentences: [{ text: 'You cannot take calls overnight.', refs: ['r1'] }] }));
  await useSummaryModel(model);
  const answer = await summary(uid, 'en');
  const prompt = promptOf(model.calls[0]!.request);
  assert.ok(prompt.includes('I cannot take calls overnight'), prompt);
  assert.ok(!prompt.includes('sleep_window:'), prompt);
  assert.equal(answer.body.summary?.status, 'ready', show(answer.body));
});

// Inspection MS-WEEKDAY-002: «الاثنين» is Monday only after a day word.
test('«الاثنين» is a weekday only after a day word, even beside a row that names Monday', async () => {
  const { validateMemorySummary } = await import('../../lib/services/mobile/memorySummary.ts');
  const gym = { ref: 'r1', id: 'a', kind: 'fact', text: 'I go to the gym on Mondays' };
  const kids = { ref: 'r2', id: 'b', kind: 'fact', text: 'عندي ولاد بالمدرسة' };
  const both = (text: string, language: 'ar' | 'he') => validateMemorySummary({ sentences: [{ text, refs: ['r1', 'r2'] }] }, [gym, kids], language);
  assert.equal(both('عندك الاثنين بالمدرسة وبتروح عالنادي.', 'ar'), null);
  assert.notEqual(both('بتروح عالنادي أيام الاثنين، وعندك ولاد بالمدرسة.', 'ar'), null);
  assert.equal(both('כל שני פרקים אתה הולך לחדר כושר ויש לך ילדים בבית הספר.', 'he'), null);
});

// Inspection round 3: the duals kept from the first list, the Hebrew article,
// and a window no survey writes.
test('friends, neighbours, schools and the Hebrew article pass; a zero-length window is not a survey row', async () => {
  const { validateMemorySummary } = await import('../../lib/services/mobile/memorySummary.ts');
  const { isCanonicalRoutineFact } = await import('../../lib/memory/routineFacts.ts');
  const one = (text: string, row: string, language: 'en' | 'he') => validateMemorySummary({ sentences: [{ text, refs: ['r1'] }] }, [{ ref: 'r1', id: 'x', kind: 'fact', text: row }], language);
  assert.notEqual(one('You have two friends at university.', 'عندي صاحبين بالجامعة', 'en'), null);
  assert.notEqual(one('You have two neighbors who help you.', 'عندي جارين بساعدوني', 'en'), null);
  assert.notEqual(one('שני הילדים שלך בבית הספר.', 'عندي ولدين بالمدرسة', 'he'), null);
  assert.equal(isCanonicalRoutineFact('quiet_hours:22:30-07:00'), true);
  assert.equal(isCanonicalRoutineFact('quiet_hours:12:00-12:00'), false);
});

// #806 part 2: every supplied row must be cited in at most 8 sentences of at
// most 220 characters, so past about 15 rows no valid answer existed and a
// person with many memories always got `unavailable`. Only the newest 15 are
// sent; coveredCount says 15 and totalCount every row, so the phone shows the rest.
const BOUND = 15;
const things = (count: number) => Array.from({ length: count }, (_, index) => ({ content: `Remembered thing number ${index}` }));
const refsIn = (prompt: string) => Array.from(prompt.matchAll(/"ref":"(r\d+)"/g), (match) => match[1]!);
const range = (count: number) => Array.from({ length: count }, (_, index) => `r${index + 1}`);

test('30 prose rows: only the newest 15 are sent (r1…r15), and an answer citing them is ready with coveredCount 15, totalCount 30', async () => {
  const { MEMORY_SUMMARY_MAX_ROWS } = await import('../../lib/services/mobile/memorySummary.ts');
  assert.equal(MEMORY_SUMMARY_MAX_ROWS, BOUND);
  const uid = await begin();
  const listed = await addRows(uid, things(30));
  const model = scriptedModel(() => ({ sentences: [
    { text: 'You keep a list of things you remember.', refs: range(8) },
    { text: 'You remember a few more things too.', refs: range(BOUND).slice(8) },
  ] }));
  await useSummaryModel(model);
  const answer = await summary(uid, 'en');
  const prompt = promptOf(model.calls[0]!.request);
  assert.deepEqual(refsIn(prompt), range(BOUND));
  for (const row of listed.slice(0, BOUND)) assert.ok(prompt.includes(`"${row.content}"`), `newest row «${row.content}» was not sent`);
  for (const row of listed.slice(BOUND)) assert.ok(!prompt.includes(`"${row.content}"`), `older row «${row.content}» was sent`);
  assert.equal(answer.body.summary?.status, 'ready', show(answer.body));
  assert.equal(answer.body.summary.coveredCount, BOUND);
  assert.equal(answer.body.summary.totalCount, 30);
  assert.deepEqual(answer.body.summary.sentences.flatMap((sentence: any) => sentence.memoryIds), listed.slice(0, BOUND).map((row) => row.id));
});

test('10 prose rows: all 10 are sent, coveredCount 10, totalCount 10', async () => {
  const uid = await begin();
  await addRows(uid, things(10));
  const model = scriptedModel(() => ({ sentences: [{ text: 'You keep a list of things you remember.', refs: range(10) }] }));
  await useSummaryModel(model);
  const answer = await summary(uid, 'en');
  assert.deepEqual(refsIn(promptOf(model.calls[0]!.request)), range(10));
  assert.equal(answer.body.summary?.status, 'ready', show(answer.body));
  assert.equal(answer.body.summary.coveredCount, 10);
  assert.equal(answer.body.summary.totalCount, 10);
});

test('the routine survey rows are dropped before the bound: 20 prose rows beside them send 15 prose rows, none of the survey\'s', async () => {
  const uid = await begin();
  await surveyRows(uid);
  await addRows(uid, things(20));
  const model = scriptedModel(() => ({ sentences: [{ text: 'You keep a list of things you remember.', refs: range(BOUND) }] }));
  await useSummaryModel(model);
  const answer = await summary(uid, 'en');
  const prompt = promptOf(model.calls[0]!.request);
  assert.deepEqual(refsIn(prompt), range(BOUND));
  assert.ok(!prompt.includes('quiet_hours'), prompt);
  assert.equal(answer.body.summary?.status, 'ready', show(answer.body));
  assert.equal(answer.body.summary.coveredCount, BOUND);
  assert.ok(answer.body.summary.totalCount > 20, show(answer.body));
});
