import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchTimeSpecForTest } from '../../lib/services/mobile/commitmentService';

// A reminder two hours ahead is a choice the user made. Moving the commitment
// must carry that gap with it, and an edit that does not touch the time must
// not touch the reminder either.

test('moving the due date carries the reminder lead time with it', () => {
  const current = {
    kind: 'due_by' as const,
    dueAt: '2026-08-23T12:00:00.000Z',
    remindAt: '2026-08-23T10:00:00.000Z', // two hours ahead
    timezone: 'Asia/Jerusalem',
  };
  const patched = patchTimeSpecForTest(current, { dueDate: '2026-08-25T12:00:00.000Z' });
  assert.equal(patched?.dueAt, '2026-08-25T12:00:00.000Z');
  assert.equal(patched?.remindAt, '2026-08-25T10:00:00.000Z');
});

test('a commitment with no reminder gains none when its due date moves', () => {
  const current = {
    kind: 'due_by' as const,
    dueAt: '2026-08-23T12:00:00.000Z',
    remindAt: null,
    timezone: 'Asia/Jerusalem',
  };
  const patched = patchTimeSpecForTest(current, { dueDate: '2026-08-25T12:00:00.000Z' });
  assert.equal(patched?.remindAt, null);
});

test('an explicit reminder time wins over the preserved lead time', () => {
  const current = {
    kind: 'due_by' as const,
    dueAt: '2026-08-23T12:00:00.000Z',
    remindAt: '2026-08-23T10:00:00.000Z',
    timezone: 'Asia/Jerusalem',
  };
  const patched = patchTimeSpecForTest(current, {
    dueDate: '2026-08-25T12:00:00.000Z',
    reminderTime: '2026-08-25T08:00:00.000Z',
  });
  assert.equal(patched?.remindAt, '2026-08-25T08:00:00.000Z');
});

test('a title-only patch leaves the time spec untouched', () => {
  // The retired Flutter client sent dueDate and reminderTime on every edit, so
  // fixing a typo collapsed the reminder onto the due time. The server side of
  // that rule: no time field in the patch, no time change.
  const current = {
    kind: 'due_by' as const,
    dueAt: '2026-08-23T12:00:00.000Z',
    remindAt: '2026-08-23T10:00:00.000Z',
    timezone: 'Asia/Jerusalem',
  };
  assert.equal(patchTimeSpecForTest(current, { title: 'Fixed a typo' }), undefined);
});
