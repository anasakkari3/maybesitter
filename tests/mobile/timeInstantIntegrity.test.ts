import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIsoInstant } from '../../lib/services/mobile/time';

// A datetime string carrying no offset is ambiguous. Node resolves it against
// the *server's* zone, so the same request stored a different instant on a
// developer's machine than on a UTC host — a silent three-hour drift for an
// Asia/Jerusalem user the moment the backend was deployed anywhere.
//
// These tests must hold regardless of the zone the suite runs in.

test('an explicit UTC instant is preserved exactly', () => {
  assert.equal(
    parseIsoInstant('2026-08-23T15:00:00.000Z', 'dueDate').toISOString(),
    '2026-08-23T15:00:00.000Z',
  );
});

test('an explicit numeric offset is honoured', () => {
  assert.equal(
    parseIsoInstant('2026-08-23T15:00:00.000+03:00', 'dueDate').toISOString(),
    '2026-08-23T12:00:00.000Z',
  );
});

test('an offset-less datetime is read as UTC, not as the server zone', () => {
  assert.equal(
    parseIsoInstant('2026-08-23T15:00:00.000', 'dueDate').toISOString(),
    '2026-08-23T15:00:00.000Z',
  );
});

test('an offset-less datetime without milliseconds is read as UTC too', () => {
  assert.equal(
    parseIsoInstant('2026-08-23T15:00:00', 'dueDate').toISOString(),
    '2026-08-23T15:00:00.000Z',
  );
});

test('a late-evening offset-less datetime keeps its own date', () => {
  // The failure this guards against moves a commitment a day, not just hours.
  assert.equal(
    parseIsoInstant('2026-08-23T23:30:00.000', 'dueDate').toISOString(),
    '2026-08-23T23:30:00.000Z',
  );
});

test('an after-midnight offset-less datetime keeps its own date', () => {
  assert.equal(
    parseIsoInstant('2026-08-23T00:30:00.000', 'dueDate').toISOString(),
    '2026-08-23T00:30:00.000Z',
  );
});

test('a date-only value keeps the UTC midnight meaning it already had', () => {
  assert.equal(
    parseIsoInstant('2026-08-23', 'dueDate').toISOString(),
    '2026-08-23T00:00:00.000Z',
  );
});

test('a non-string or unparseable value still reports which field was wrong', () => {
  assert.throws(() => parseIsoInstant(undefined, 'dueDate'), /dueDate/);
  assert.throws(() => parseIsoInstant('not a date', 'reminderTime'), /reminderTime/);
});
