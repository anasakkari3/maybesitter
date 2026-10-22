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
import { tidyTitle } from '../../lib/services/captureBoundary/proposalShape.ts';

test('#737: a title’s own leading “and” survives clause splitting', () => {
  const text = 'And Then There Were None rehearsal tomorrow at 5';
  assert.deepEqual(splitCaptureClauses(text), [text]);
});

test('#737: a title’s own leading “and” survives title cleanup', () => {
  const text = 'And Then There Were None rehearsal tomorrow at 5';
  assert.equal(tidyTitle(text), text);
});

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
    ['Dentist on Sunday at 10. I\u2019m thinking of moving to Haifa', 2],
    ['Dentist on Sunday at 10. Someday I want to learn piano', 2],
    ['רופא שיניים ביום ראשון ב-10. אני חושב על לעבור דירה', 2],
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

test('BB-04 review (Codex M6B-R2-001): a bare hedge after a period stays with the point before', () => {
  for (const text of [
    'اجتماع مع المدير الساعة 5. ممكن يتأخر شوي',
    'عندي امتحان الأحد. يمكن يأجلوه',
    'عندي موعد. ممكن الساعة 5',
    'عندي موعد الساعة 5. ممكن أحمد يتأخر',
    'פגישה ב-5. אולי תתארך',
    'פגישה ב-5. אולי נועה תאחר',
    'اجتماع الساعة 5. ممكن: يتأخر شوي',
    'Meeting at 5. Maybe it runs late',
  ]) {
    assert.equal(splitCaptureClauses(text).length, 1, `${text} → ${JSON.stringify(splitCaptureClauses(text))}`);
  }
  // The explicit markers still open a point.
  for (const text of [
    'عندي امتحان الأحد. عم بفكر أسافر بعده',
    'عندي امتحان الأحد. ناوي أروح على البحر بعده',
    'Dentist Sunday at 10. Maybe I will skip it',
  ]) {
    assert.equal(splitCaptureClauses(text).length, 2, `${text} → ${JSON.stringify(splitCaptureClauses(text))}`);
  }
});

test('BB-04 review (Codex M6B-R4-002): a timed thought after a day-only point is its own point (ar / en / he)', () => {
  for (const text of [
    "Dentist on Sunday. I'm thinking of calling the airline at 5",
    // A modal before the action is still an action (Codex M6B-R6-004).
    "Dentist on Sunday. I'm thinking I should call the airline at 5",
    "Dentist on Sunday. I'm thinking I can book the flight at 5",
    "Dentist on Sunday. I'm thinking I will pay the bill at 5",
    // A copula about something else, or before an action (Codex M6B-R7-003).
    "Dentist on Sunday. I'm thinking my flight should be at 5",
    "Dentist on Sunday. I'm thinking I will be calling the airline at 5",
    // The speaker doing something with no object, and a smart apostrophe (Codex M6B-R10-003/004).
    "Dentist on Sunday. I'm thinking I will be running at 5",
    // Two subjects sharing only a connective are different things (Codex M6B-R11-001).
    "Meeting with Alice on Sunday. I'm thinking my flight with Bob should be at 5",
    // A shared person or day is a modifier, not the same thing (Codex M6B-R12-002).
    "Meeting with Alice on Sunday. I'm thinking my flight with Alice should be at 5",
    "Dentist on Sunday. I'm thinking my flight Sunday should be at 5",
    "Dentist on Sunday. I\u2019m thinking of calling the airline at 5",
    'عندي طبيب أسنان يوم الأحد. عم بفكر أسافر الساعة 5',
    'רופא שיניים ביום ראשון. אני חושב על לעבור דירה בשעה 5',
  ]) {
    const clauses = splitCaptureClauses(text);
    assert.equal(clauses.length, 2, `${text} → ${JSON.stringify(clauses)}`);
  }
});

test('BB-04 review (Codex M6B-R4-002): an hour that only restates the appointment still attaches', () => {
  for (const text of [
    'عندي موعد بكرا. حابب يكون الساعة 5',
    'Interview on Tuesday. Zoom at 3pm',
    'Dentist on Sunday. Call is at 10am',
    'عندي موعد بكرا. بدي أكون هناك الساعة 5 المسا',
  ]) {
    const clauses = splitCaptureClauses(text);
    assert.equal(clauses.length, 1, `${text} → ${JSON.stringify(clauses)}`);
  }
});

test('BB-04 review (Codex M6B-R5-003): a thought about the appointment\'s own hour stays with it (ar / en / he)', () => {
  for (const text of [
    "Dentist on Sunday. I'm thinking the appointment should be at 5",
    "Dentist on Sunday. I'm thinking it's at 5",
    "Dentist on Sunday. I'm thinking the dentist should be at 5",
    "Dentist on Sunday. I'm thinking I should be there at 5",
    // An adjective or a noun after the copula still describes it (Codex M6B-R8-004).
    "Dentist on Sunday. I'm thinking the dentist should be available at 5",
    "Dentist on Sunday. I'm thinking the appointment is a video call at 5",
    "Dentist on Sunday. I'm thinking the appointment should be starting at 5",
    'عندي طبيب أسنان يوم الأحد. عم بفكر الموعد يكون الساعة 5',
    'רופא שיניים ביום ראשון. אני חושב על התור שיהיה בשעה 5',
  ]) {
    const clauses = splitCaptureClauses(text);
    assert.equal(clauses.length, 1, `${text} → ${JSON.stringify(clauses)}`);
  }
});
