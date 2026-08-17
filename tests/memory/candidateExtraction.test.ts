import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidatesRuleBased } from '../../src/extraction/ruleBasedCandidateExtractor.ts';

const now = new Date('2026-08-03T12:00:00.000Z');

test('extraction: "يمكن أزور خالي" → possible', () => {
  const candidates = extractCandidatesRuleBased('يمكن أزور خالي', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].modality, 'possible');
  assert.equal(candidates[0].candidateType, 'commitment');
  assert.ok(candidates[0].confidence < 0.70);
});

test('extraction: "ناوي أزور خالي الخميس" → intended', () => {
  const candidates = extractCandidatesRuleBased('ناوي أزور خالي الخميس', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].modality, 'intended');
});

test('extraction: "خلص رايح على خالي الخميس" → certain', () => {
  const candidates = extractCandidatesRuleBased('خلص رايح على خالي الخميس', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].modality, 'certain');
});

test('extraction: "ذكرني أزور خالي الخميس" → certain', () => {
  const candidates = extractCandidatesRuleBased('ذكرني أزور خالي الخميس', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].modality, 'certain');
  assert.ok(candidates[0].confidence >= 0.85);
});

test('extraction: "مش رايح الخميس" → negated', () => {
  const candidates = extractCandidatesRuleBased('مش رايح الخميس', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].modality, 'negated');
});

test('extraction: "كنت بدي أروح بس بطلت" → negated', () => {
  const candidates = extractCandidatesRuleBased('كنت بدي أروح بس بطلت', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].modality, 'negated');
});

test('extraction: "لا تذكرني بالموضوع" → negated', () => {
  const candidates = extractCandidatesRuleBased('لا تذكرني بالموضوع', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].modality, 'negated');
});

test('extraction: "إذا خلصت بدري، بروح عالجيم" → conditional', () => {
  const candidates = extractCandidatesRuleBased('إذا خلصت بدري، بروح عالجيم', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].modality, 'conditional');
});

test('extraction: "أمي قالت إنها ستزور خالتي الخميس" → reported', () => {
  const candidates = extractCandidatesRuleBased('أمي قالت إنها ستزور خالتي الخميس', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].modality, 'reported');
});

test('extraction: "remind me to call the doctor tomorrow" → certain', () => {
  const candidates = extractCandidatesRuleBased('remind me to call the doctor tomorrow', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].modality, 'certain');
  assert.ok(candidates[0].temporal);
  assert.equal(candidates[0].temporal!.precision, 'day');
});

test('extraction: "maybe I will go to the gym" → possible', () => {
  const candidates = extractCandidatesRuleBased('maybe I will go to the gym', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].modality, 'possible');
});

test('extraction: "I won\'t go on Thursday" → negated', () => {
  const candidates = extractCandidatesRuleBased("I won't go on Thursday", { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].modality, 'negated');
});

test('extraction: empty text → no candidates', () => {
  const candidates = extractCandidatesRuleBased('', { now });
  assert.equal(candidates.length, 0);
});

test('extraction: temporal detection for بكرا', () => {
  const candidates = extractCandidatesRuleBased('ذكرني بكرا أتصل بالدكتور', { now });
  assert.ok(candidates[0].temporal);
  assert.equal(candidates[0].temporal!.rawText, 'بكرا');
  assert.equal(candidates[0].temporal!.precision, 'day');
});

test('extraction: temporal detection for الساعة', () => {
  const candidates = extractCandidatesRuleBased('خلص الخميس الساعة 7', { now });
  assert.ok(candidates[0].temporal);
  assert.equal(candidates[0].temporal!.precision, 'exact');
});

test('extraction: evidence span covers full text', () => {
  const text = 'يمكن أزور خالي';
  const candidates = extractCandidatesRuleBased(text, { now });
  assert.equal(candidates[0].evidenceSpan.start, 0);
  assert.equal(candidates[0].evidenceSpan.end, text.length);
  assert.equal(candidates[0].evidenceSpan.text, text);
});

test('extraction: "I don\'t like going to the gym three days in a row" → preference', () => {
  const candidates = extractCandidatesRuleBased("I don't like going to the gym three days in a row", { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateType, 'preference');
});

test('extraction: "ما بحب اروح الجيم" → preference', () => {
  const candidates = extractCandidatesRuleBased('ما بحب اروح الجيم', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateType, 'preference');
});

test('extraction: "I prefer working on projects in the evening" → preference', () => {
  const candidates = extractCandidatesRuleBased('I prefer working on projects in the evening', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateType, 'preference');
});

test('extraction: "I work Tuesday from 17:00 to 20:00" → fact', () => {
  const candidates = extractCandidatesRuleBased('I work Tuesday from 17:00 to 20:00', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateType, 'fact');
});

test('extraction: "بشتغل الثلاثاء من الخامسة للثامنة" → fact', () => {
  const candidates = extractCandidatesRuleBased('بشتغل الثلاثاء من الخامسة للثامنة', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateType, 'fact');
});

test('extraction: "I will work on Tuesday" stays a commitment, not a fact (overlap guard)', () => {
  const candidates = extractCandidatesRuleBased('I will work on Tuesday', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateType, 'commitment');
  assert.equal(candidates[0].modality, 'certain');
});

test('extraction: existing commitment fixtures are unaffected by the new preference/fact patterns', () => {
  // Regression check: every pre-existing commitment-classification test text must still
  // classify as 'commitment'.
  const stillCommitments = [
    'يمكن أزور خالي',
    'ناوي أزور خالي الخميس',
    'خلص رايح على خالي الخميس',
    'ذكرني أزور خالي الخميس',
    'مش رايح الخميس',
    'إذا خلصت بدري، بروح عالجيم',
    'remind me to call the doctor tomorrow',
    'maybe I will go to the gym',
    "I won't go on Thursday",
  ];
  for (const text of stillCommitments) {
    const candidates = extractCandidatesRuleBased(text, { now });
    assert.equal(candidates[0].candidateType, 'commitment', `expected "${text}" to stay a commitment`);
  }
});
