/**
 * What survives between the model and the user's screen (UC-2.7b, #168).
 *
 * ── The test that matters ────────────────────────────────────────
 *
 * A model stub returns "has ADHD and takes Ritalin", in all three languages,
 * perfectly formed and highly confident. Nothing about the shape of it is
 * wrong. It must not reach the screen anyway — the prompt asks and this
 * refuses, and a product that writes that down because the prompt was ignored
 * once has done the harm regardless of whose fault it was.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProfileSuggestions } from '../../src/profile/profileSuggestionValidator.ts';
import { sensitiveTermIn } from '../../src/profile/sensitiveLexicon.ts';
import { MAX_PROFILE_SUGGESTIONS } from '../../src/profile/profileContracts.ts';

const NOW = new Date('2026-09-13T09:00:00.000Z');

function suggestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'goal',
    category: 'learning',
    content: 'Finish the thesis',
    targetDate: '2027-03-01',
    confidence: 0.9,
    ...overrides,
  };
}

function validate(items: unknown[]) {
  return validateProfileSuggestions(items, { now: NOW });
}

// ── The sensitive filter ─────────────────────────────────────────

test('a perfectly-formed health claim is refused anyway', () => {
  // Well-shaped, in-enum, high confidence. Every other rule passes it.
  const result = validate([
    suggestion({ kind: 'fact', category: 'other', content: 'Has ADHD and takes Ritalin', targetDate: null }),
  ]);
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.dropped.sensitive, 1);
});

test('the same claim is refused in Arabic and Hebrew', () => {
  // The filter is not an English filter that happens to run on everything.
  const arabic = validate([suggestion({ kind: 'fact', category: 'other', content: 'بياخد دواء كل يوم', targetDate: null })]);
  const hebrew = validate([suggestion({ kind: 'fact', category: 'other', content: 'לוקח תרופות כל יום', targetDate: null })]);
  assert.deepEqual(arabic.suggestions, []);
  assert.deepEqual(hebrew.suggestions, []);
  assert.equal(arabic.dropped.sensitive, 1);
  assert.equal(hebrew.dropped.sensitive, 1);
});

test('every protected category is covered, in all three languages', () => {
  const shouldBeCaught = [
    // health · care · religion · ethnicity · orientation · politics · money
    'Diagnosed with anxiety', 'Sees a therapist on Tuesdays',
    'Goes to church on Sunday', 'Is Palestinian', 'Is gay',
    'Votes for the party', 'Salary is late again',
    'عنده اكتئاب', 'بيروح عالمسجد', 'راتبه تأخر',
    'יש לו חרדה', 'הולך לבית כנסת', 'המשכורת מאחרת',
  ];
  for (const content of shouldBeCaught) {
    assert.ok(sensitiveTermIn(content), `not caught: ${content}`);
  }
});

test('an ordinary goal is not caught by the filter', () => {
  // The filter over-matches on purpose, but it has to leave the product usable.
  const shouldSurvive = [
    'Finish the thesis', 'Run a marathon in April', 'Call the landlord',
    'Study two hours each evening', 'Cook at home more often',
    'يخلّص الأطروحة', 'يركض كل صباح',
    'לסיים את התזה', 'לרוץ כל בוקר',
  ];
  for (const content of shouldSurvive) {
    assert.equal(sensitiveTermIn(content), null, `wrongly caught: ${content} (${sensitiveTermIn(content)})`);
  }
});

test('the filter is not fooled by Arabic diacritics', () => {
  assert.ok(sensitiveTermIn('بياخد دَواء'), 'a diacritic hid the term');
});

// ── Nothing is repaired ──────────────────────────────────────────

test('a confidence outside 0..1 is dropped, not clamped', () => {
  // Clamping 1.4 to 1 would turn a malformed answer into a maximally confident
  // claim about a person.
  for (const confidence of [1.4, -0.2, Number.NaN, Number.POSITIVE_INFINITY, '0.9']) {
    const result = validate([suggestion({ confidence })]);
    assert.deepEqual(result.suggestions, [], `accepted confidence ${String(confidence)}`);
    assert.equal(result.dropped.bad_confidence, 1);
  }
});

test('an over-long suggestion is dropped, not truncated', () => {
  // Truncating would show somebody half a sentence about themselves that
  // neither they nor the model produced.
  const result = validate([suggestion({ content: 'x'.repeat(81) })]);
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.dropped.too_long, 1);
  // 80 exactly is fine: the bound is inclusive.
  assert.equal(validate([suggestion({ content: 'x'.repeat(80) })]).suggestions.length, 1);
});

test('length is counted in code points, so Arabic gets the same allowance', () => {
  const arabic = 'ك'.repeat(80);
  assert.equal(validate([suggestion({ content: arabic })]).suggestions.length, 1);
});

test('an unknown kind or category is dropped, never mapped to "other"', () => {
  assert.equal(validate([suggestion({ kind: 'hypothesis' })]).dropped.unknown_kind, 1);
  assert.equal(validate([suggestion({ category: 'health' })]).dropped.unknown_category, 1);
});

// ── Confidence and dates ─────────────────────────────────────────

test('a low-confidence suggestion is dropped', () => {
  assert.equal(validate([suggestion({ confidence: 0.59 })]).dropped.low_confidence, 1);
  assert.equal(validate([suggestion({ confidence: 0.6 })]).suggestions.length, 1);
});

test('a target date in the past drops the whole suggestion', () => {
  // Not just the date: re-dating it would be this code deciding when somebody
  // meant, and keeping a goal whose deadline has gone is not keeping the goal.
  const result = validate([suggestion({ targetDate: '2026-09-12' })]);
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.dropped.past_target_date, 1);
  // Today is not the past.
  assert.equal(validate([suggestion({ targetDate: '2026-09-13' })]).suggestions.length, 1);
});

test('a malformed target date drops the suggestion', () => {
  for (const targetDate of ['soon', '2026-13-01', '01/03/2027', '2027-03']) {
    assert.equal(validate([suggestion({ targetDate })]).suggestions.length, 0, `accepted ${targetDate}`);
  }
});

test('no target date is fine, and stays null', () => {
  for (const targetDate of [null, undefined, '']) {
    const result = validate([suggestion({ targetDate })]);
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0]!.targetDate, null);
  }
});

// ── Bounds and shape ─────────────────────────────────────────────

test('no more than eight survive, however many arrive', () => {
  const many = Array.from({ length: 20 }, (_, i) => suggestion({ content: `Goal ${i}`, targetDate: null }));
  const result = validate(many);
  assert.equal(result.suggestions.length, MAX_PROFILE_SUGGESTIONS);
  assert.equal(result.dropped.over_limit, 12);
});

test('anything that is not a list of objects yields nothing', () => {
  for (const raw of [null, undefined, 'text', 42, {}]) {
    assert.deepEqual(validateProfileSuggestions(raw, { now: NOW }).suggestions, []);
  }
  assert.deepEqual(validate([null, 'x', 42]).suggestions, []);
});

test('what comes out is frozen, and carries only the contract fields', () => {
  const result = validate([suggestion({ extra: 'smuggled', source: 'user_stated' })]);
  const kept = result.suggestions[0]!;
  assert.deepEqual(Object.keys(kept).sort(), ['category', 'confidence', 'content', 'kind', 'targetDate']);
  assert.equal(Object.isFrozen(kept), true);
});

test('the outcome reports counts and never the content that was dropped', () => {
  const result = validate([
    suggestion({ content: 'Has ADHD', targetDate: null }),
    suggestion({ confidence: 0.1 }),
  ]);
  const serialised = JSON.stringify(result.dropped);
  assert.ok(!serialised.includes('ADHD'), `the drop report carries content: ${serialised}`);
  assert.deepEqual(result.dropped, { sensitive: 1, low_confidence: 1 });
});

// ── The issue's worked example ───────────────────────────────────

test('the example keeps the thesis goal and discards the health reading', () => {
  const fromModel = [
    suggestion({ kind: 'goal', category: 'learning', content: 'Finish the thesis', targetDate: '2027-03-15' }),
    suggestion({ kind: 'preference', category: 'schedule', content: 'Studies in the evenings', targetDate: null }),
    suggestion({ kind: 'fact', category: 'work_study', content: 'Is a nursing student', targetDate: null }),
    // The one the prompt was told not to produce.
    suggestion({ kind: 'fact', category: 'other', content: 'Nursing student is stressed and sees a therapist', targetDate: null }),
  ];
  const result = validate(fromModel);
  assert.equal(result.suggestions.length, 3);
  assert.ok(result.suggestions.some((s) => s.kind === 'goal' && s.targetDate?.startsWith('2027-03')));
  assert.ok(!result.suggestions.some((s) => s.content.includes('therapist')));
  assert.equal(result.dropped.sensitive, 1);
});
