/**
 * M6b black-box finding BB-04 (#743): on the rules path, sentences joined by
 * «. » were split only before a request or an errand verb, so a thought and a
 * someday goal were glued onto the point before them — five points became
 * three, a meeting carried a trip, and a goal drew «أي ساعة؟».
 *
 * A sentence now also opens a point when it starts with an unresolved-intent
 * marker (the same table that lets «و» open one) or with «حابب / ناوي». What
 * must stay joined still does: an hour restating the appointment, a bare time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCaptureClauses } from '../../src/extraction/clauseSplitter.ts';

test('BB-04: five points joined by «. » are five clauses (the black-box repro)', () => {
  const clauses = splitCaptureClauses(
    'لقاء مع سامي بكرا من 4 لـ 8 المسا. عم بفكر أسافر الصيف الجاي. بدي أمشي نص ساعة كل يوم. لازم أدفع فاتورة الكهربا يوم الأحد. حابب أنزل بالوزن',
  );
  assert.equal(clauses.length, 5, JSON.stringify(clauses));
  assert.match(clauses[0]!, /^لقاء مع سامي بكرا من 4 لـ 8 المسا\.?$/);
  assert.match(clauses[1]!, /^عم بفكر أسافر الصيف الجاي\.?$/);
  assert.match(clauses[3]!, /^لازم أدفع فاتورة الكهربا يوم الأحد\.?$/);
  assert.match(clauses[4]!, /^حابب أنزل بالوزن$/);
});

test('BB-04: each intent marker after a period opens its own clause (ar / en / he)', () => {
  for (const [text, expected] of [
    ['عندي موعد دكتور بكرا الساعة 5. مستني رد من الشركة', 2],
    ['عندي موعد دكتور بكرا الساعة 5. حلمي أتعلم بيانو', 2],
    ['عندي موعد دكتور بكرا الساعة 5. ناوي أبلش رياضة', 2],
    ["Dentist on Sunday at 10. I'm thinking of moving to Haifa", 2],
    ['Dentist on Sunday at 10. Someday I want to learn piano', 2],
    ['רופא שיניים ביום ראשון ב-10. אולי אעבור דירה', 2],
  ] as const) {
    assert.equal(splitCaptureClauses(text).length, expected, `${text} → ${JSON.stringify(splitCaptureClauses(text))}`);
  }
});

test('BB-04 guards: a sentence that restates the hour or is only a time still belongs to the one before', () => {
  for (const text of [
    'عندي موعد دكتور بكرا. الساعة 5 المسا',
    'عندي موعد دكتور بكرا. حابب يكون الساعة 5 المسا',
    'Interview on Tuesday. Zoom at 3pm',
  ]) {
    assert.equal(splitCaptureClauses(text).length, 1, `${text} → ${JSON.stringify(splitCaptureClauses(text))}`);
  }
});

test('BB-04 review: a bare hedge before a third-person verb is a remark on the point before, not a point', () => {
  for (const text of [
    'اجتماع مع المدير الساعة 5. ممكن يتأخر شوي',
    'عندي امتحان الأحد. يمكن يأجلوه',
    'פגישה ב-5. אולי תתארך',
    'Meeting at 5. Maybe it runs late',
    // Codex M6B-R01: punctuation after the hedge does not change whose verb it is.
    // (The Arabic comma «،» is not used here: it is a hard separator by the
    // splitter's older rule and splits wherever it stands.)
    'اجتماع الساعة 5. ممكن: يتأخر شوي',
    'פגישה ב-5. אולי, תתארך',
  ]) {
    assert.equal(splitCaptureClauses(text).length, 1, `${text} → ${JSON.stringify(splitCaptureClauses(text))}`);
  }
  for (const text of [
    'عندي امتحان الأحد. يمكن أسافر بعده',
    'عندي امتحان الأحد. ممكن بروح على البحر بعده',
    'רופא שיניים ביום ראשון ב-10. אולי אעבור דירה',
    'Dentist Sunday at 10. Maybe I will skip it',
  ]) {
    assert.equal(splitCaptureClauses(text).length, 2, `${text} → ${JSON.stringify(splitCaptureClauses(text))}`);
  }
});
