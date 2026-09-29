/**
 * The weekly fixed block's contract («ثابت أسبوعي», owner request 2026-09-29).
 *
 * "Work from 10 until 4 every Saturday — reserve it every week until I change
 * it." The contract is the boundary every door goes through — the POST route,
 * the PATCH route and the capture confirm — so what it refuses is refused
 * everywhere: no block without a person's confirmation, 1–7 distinct
 * weekdays, a start before its end on the same day (overnight is v2 and is
 * said so, not silently wrapped), a title of 1–120 characters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKLY_BLOCK_TITLE_MAX,
  WeeklyBlockValidationError,
  parseWeeklyBlockInput,
  parseWeeklyBlockPatch,
  validateWeeklyBlockShape,
} from '../../src/contracts/v1/weeklyBlockContracts.ts';

const CONFIRMED = { confirmedByUserAt: '2026-09-29T10:00:00.000Z' };
const valid = {
  title: 'تدريب',
  weekdays: [6],
  start: '10:00',
  end: '16:00',
  timezone: 'Asia/Jerusalem',
  confirmation: CONFIRMED,
};

function refusedWith(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof WeeklyBlockValidationError && error.code === code, code);
}

test('a confirmed Saturday 10:00–16:00 block is accepted, weekdays sorted and unique', () => {
  const parsed = parseWeeklyBlockInput({ ...valid, weekdays: [6, 1] });
  assert.deepEqual(parsed, {
    title: 'تدريب',
    weekdays: [1, 6],
    start: '10:00',
    end: '16:00',
    timezone: 'Asia/Jerusalem',
    confirmedAt: '2026-09-29T10:00:00.000Z',
  });
});

test('no confirmation, no block: the body must carry the moment the person confirmed', () => {
  const { confirmation: _c, ...unconfirmed } = valid;
  refusedWith(() => parseWeeklyBlockInput(unconfirmed), 'confirmation_required');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, confirmation: {} }), 'confirmation_required');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, confirmation: { confirmedByUserAt: 'soon' } }), 'confirmation_required');
});

test('weekdays: 1..7 distinct integers 0 (Sunday) … 6 (Saturday)', () => {
  refusedWith(() => parseWeeklyBlockInput({ ...valid, weekdays: [] }), 'invalid_weekdays');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, weekdays: [6, 6] }), 'invalid_weekdays');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, weekdays: [7] }), 'invalid_weekdays');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, weekdays: [-1] }), 'invalid_weekdays');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, weekdays: [1.5] }), 'invalid_weekdays');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, weekdays: '6' }), 'invalid_weekdays');
  assert.deepEqual(parseWeeklyBlockInput({ ...valid, weekdays: [0, 1, 2, 3, 4, 5, 6] }).weekdays, [0, 1, 2, 3, 4, 5, 6]);
});

test('times are HH:MM and the start comes before the end on the same day', () => {
  refusedWith(() => parseWeeklyBlockInput({ ...valid, start: '10' }), 'invalid_time');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, end: '24:00' }), 'invalid_time');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, start: '9:00' }), 'invalid_time');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, start: '16:00', end: '16:00' }), 'overnight_not_supported');
  // 22:00–02:00 is a night shift; v1 says so rather than wrapping it into the next day.
  refusedWith(() => parseWeeklyBlockInput({ ...valid, start: '22:00', end: '02:00' }), 'overnight_not_supported');
  assert.equal(parseWeeklyBlockInput({ ...valid, start: '00:00', end: '23:59' }).end, '23:59');
});

test('title: 1..120 characters after trimming', () => {
  refusedWith(() => parseWeeklyBlockInput({ ...valid, title: '   ' }), 'invalid_title');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, title: 7 }), 'invalid_title');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, title: 'x'.repeat(WEEKLY_BLOCK_TITLE_MAX + 1) }), 'invalid_title');
  assert.equal(parseWeeklyBlockInput({ ...valid, title: ` ${'x'.repeat(WEEKLY_BLOCK_TITLE_MAX)} ` }).title.length, WEEKLY_BLOCK_TITLE_MAX);
});

test('the timezone must be a zone Intl can format in', () => {
  refusedWith(() => parseWeeklyBlockInput({ ...valid, timezone: 'Mars/Olympus' }), 'invalid_timezone');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, timezone: undefined }), 'invalid_timezone');
});

test('an unknown key is refused by name, not dropped', () => {
  refusedWith(() => parseWeeklyBlockInput({ ...valid, status: 'active' }), 'unknown_field');
  refusedWith(() => parseWeeklyBlockInput({ ...valid, scopeId: 'someone-else' }), 'unknown_field');
});

test('a patch names at least one of title, weekdays, start, end, status — and nothing else', () => {
  assert.deepEqual(parseWeeklyBlockPatch({ status: 'paused' }), { status: 'paused' });
  assert.deepEqual(parseWeeklyBlockPatch({ title: ' دوام ', weekdays: [5, 4] }), { title: 'دوام', weekdays: [4, 5] });
  refusedWith(() => parseWeeklyBlockPatch({}), 'empty_patch');
  refusedWith(() => parseWeeklyBlockPatch({ status: 'deleted' }), 'invalid_status');
  refusedWith(() => parseWeeklyBlockPatch({ confirmation: CONFIRMED }), 'unknown_field');
  refusedWith(() => parseWeeklyBlockPatch({ timezone: 'UTC' }), 'unknown_field');
  refusedWith(() => parseWeeklyBlockPatch({ start: '25:00' }), 'invalid_time');
});

test('the merged shape is checked again: a patch cannot move the start past the end', () => {
  refusedWith(() => validateWeeklyBlockShape({ weekdays: [6], start: '17:00', end: '16:00' }), 'overnight_not_supported');
  assert.doesNotThrow(() => validateWeeklyBlockShape({ weekdays: [6], start: '09:00', end: '16:00' }));
});
