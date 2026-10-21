/**
 * M6a-1 Gate B — M6A-008 + M6A-R4-002: "describe yourself" writes in one
 * resolved target locale, and a suggestion whose first strong script is not
 * that target is refused. Not flagged: it changes only new suggestions.
 *
 * The service seam is the existing `options.complete` of `describeProfile`;
 * the build adds `options.locale` (the route passes the validated body field).
 * The resolved target is named in the prompt as one exact line,
 * `Target language: <ar|en|he>` (a Gate B contract, so the resolution is
 * observable without a model).
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { describeProfile } from '../../../lib/services/mobile/profileDescribeService.ts';
import { begin, call, end, setAccount, show } from './support.ts';

afterEach(() => end());

function modelAnswering(contents: string[]) {
  const prompts: string[] = [];
  const complete = async (prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify({ suggestions: contents.map((content) => ({ kind: 'fact', category: 'other', content, confidence: 0.9 })) });
  };
  return { complete, prompts };
}

const describe = (uid: string, text: string, options: Record<string, unknown>) =>
  describeProfile(uid, text, new Date(), options as any);

test('M6A-008 the prompt names the requested app locale, not "the language the person used"', async () => {
  for (const locale of ['ar', 'en', 'he'] as const) {
    const uid = await begin({}, { locale: 'en' });
    const model = modelAnswering([]);
    await describe(uid, 'I am a third year software engineering student', { complete: model.complete, locale });
    assert.equal(model.prompts.length, 1);
    assert.match(model.prompts[0]!, new RegExp(`^Target language: ${locale}$`, 'm'), `prompt for ${locale} does not name it`);
    assert.doesNotMatch(model.prompts[0]!, /same language the person used/i);
    end();
  }
});

test('M6A-R4-002 fallback order: body locale → user document locale → first strong script of the input → ar', async () => {
  const cases: Array<{ doc?: string; input: string; expected: string }> = [
    { doc: 'he', input: 'I study at night', expected: 'he' },
    { input: 'אני לומד בלילה', expected: 'he' },
    { input: 'I study at night', expected: 'en' },
    { input: 'بدرس بالليل', expected: 'ar' },
    { input: '12345 ...', expected: 'ar' },
  ];
  for (const { doc, input, expected } of cases) {
    const uid = await begin();
    await setAccount(uid, { locale: doc ?? null });
    const model = modelAnswering([]);
    await describe(uid, input, { complete: model.complete });
    assert.match(model.prompts[0]!, new RegExp(`^Target language: ${expected}$`, 'm'), `doc=${doc} input=${input}: expected ${expected}`);
    end();
  }
});

test('M6A-R4-002 a suggestion whose first strong script is not the target is refused (model ignored the locale)', async () => {
  const uid = await begin();
  const model = modelAnswering(['Is a third year software engineering student', 'طالب سنة تالتة هندسة برمجيات', 'بيستعمل Notion للمهام']);
  const proposal = await describe(uid, 'I am a third year software engineering student', { complete: model.complete, locale: 'ar' });
  const contents = (proposal.suggestions as unknown as Array<{ content: string }>).map((s) => s.content);
  assert.ok(!contents.includes('Is a third year software engineering student'), show(contents));
  assert.ok(contents.includes('طالب سنة تالتة هندسة برمجيات'), show(contents));
  assert.ok(contents.includes('بيستعمل Notion للمهام'), 'a Latin name inside an Arabic sentence is allowed');
});

test('M6A-R5-003 script share, not first script: at most two foreign-script tokens; every other letter in the target script', async () => {
  const cases: Array<{ target: 'ar' | 'en' | 'he'; content: string; kept: boolean }> = [
    { target: 'en', content: 'Google \u0628\u0639\u0631\u0641 \u0639\u0646 \u0645\u0648\u0627\u0639\u064A\u062F\u064A', kept: false }, // «Google بعرف عن مواعيدي»
    { target: 'en', content: 'Ahmad works with me', kept: true },
    { target: 'ar', content: '\u0623\u062D\u0645\u062F works with me', kept: false }, // «أحمد works with me»
    { target: 'ar', content: '\u0628\u064A\u0633\u062A\u0639\u0645\u0644 Notion \u0644\u0644\u0645\u0647\u0627\u0645', kept: true }, // «بيستعمل Notion للمهام»
    { target: 'ar', content: '\u05E9\u05D9\u05E8\u05D4 \u05DC\u05D5\u05DE\u05D3\u05EA \u05D1\u05E2\u05E8\u05D1', kept: false }, // «שירה לומדת בערב»
    { target: 'ar', content: '\u0628\u062A\u062F\u0631\u0633 \u0645\u0639 \u05E9\u05D9\u05E8\u05D4 \u0628\u0627\u0644\u0644\u064A\u0644', kept: true }, // «بتدرس مع שירה بالليل»
  ];
  for (const { target, content, kept } of cases) {
    const uid = await begin();
    const model = modelAnswering([content]);
    const proposal = await describe(uid, 'x', { complete: model.complete, locale: target });
    const contents = (proposal.suggestions as unknown as Array<{ content: string }>).map((s) => s.content);
    assert.equal(contents.includes(content), kept, `${target}: ${content}`);
    end();
  }
});

test('M6A-008 the route accepts a strict optional locale and refuses anything else', async () => {
  const uid = await begin();
  const bad = await call(uid, 'profile/describe', 'POST', { body: { text: 'hello', locale: 'fr' } });
  assert.equal(bad.status, 400, show(bad.body));
});
