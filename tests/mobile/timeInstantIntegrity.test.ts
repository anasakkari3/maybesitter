import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDayKey, parseIsoDate, parseIsoInstant } from '../../lib/services/mobile/time';

// A datetime string carrying no offset is ambiguous. Node resolves it against
// the *server's* zone, so the same request stored a different instant on a
// developer's machine than on a UTC host — a silent three-hour drift for an
// Asia/Jerusalem user the moment the backend was deployed anywhere.
//
// These tests must hold regardless of the zone the suite runs in, so every
// test runs itself under four zones instead of trusting the shell's. Under
// TZ=UTC alone the original bug — `new Date()` on an offset-less string —
// reads exactly like the fix, and all of these assertions passed against it.

const ZONES = ['UTC', 'Asia/Jerusalem', 'America/Los_Angeles', 'Pacific/Kiritimati'] as const;

function inZone(zone: string, run: () => void): void {
  const original = process.env.TZ;
  try {
    process.env.TZ = zone;
    run();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

function inEachZone(run: (zone: string) => void): void {
  for (const zone of ZONES) inZone(zone, () => run(zone));
}

test('the zone sweep really moves offset-less parsing', () => {
  // If assigning TZ stopped reaching Date, every test below would silently
  // collapse back into a single-zone run.
  inEachZone((zone) => {
    if (zone === 'UTC') return;
    assert.notEqual(
      new Date('2026-08-23T15:00:00.000').toISOString(),
      '2026-08-23T15:00:00.000Z',
      `[${zone}] TZ assignment did not take effect; this file proves nothing`,
    );
  });
});

test('the sweep catches the server-zone bug this file guards against', () => {
  // A live example of the defect: the zone-dependent parse still exists as
  // parseIsoDate, and under a non-UTC zone it disagrees with parseIsoInstant.
  const zone = 'Asia/Jerusalem';
  inZone(zone, () => {
    assert.notEqual(
      parseIsoDate('2026-08-23T15:00:00.000', 'x').toISOString(),
      parseIsoInstant('2026-08-23T15:00:00.000', 'x').toISOString(),
      `[${zone}] the buggy parse and the fix agree, so the sweep cannot tell them apart`,
    );
  });
});

test('an explicit UTC instant is preserved exactly', () => {
  inEachZone((zone) => {
    assert.equal(
      parseIsoInstant('2026-08-23T15:00:00.000Z', 'dueDate').toISOString(),
      '2026-08-23T15:00:00.000Z',
      `[${zone}] explicit Z instant`,
    );
  });
});

test('an explicit numeric offset is honoured', () => {
  inEachZone((zone) => {
    assert.equal(
      parseIsoInstant('2026-08-23T15:00:00.000+03:00', 'dueDate').toISOString(),
      '2026-08-23T12:00:00.000Z',
      `[${zone}] explicit +03:00 offset`,
    );
  });
});

test('an offset-less datetime is read as UTC, not as the server zone', () => {
  inEachZone((zone) => {
    assert.equal(
      parseIsoInstant('2026-08-23T15:00:00.000', 'dueDate').toISOString(),
      '2026-08-23T15:00:00.000Z',
      `[${zone}] offset-less datetime`,
    );
  });
});

test('an offset-less datetime without milliseconds is read as UTC too', () => {
  inEachZone((zone) => {
    assert.equal(
      parseIsoInstant('2026-08-23T15:00:00', 'dueDate').toISOString(),
      '2026-08-23T15:00:00.000Z',
      `[${zone}] offset-less datetime without milliseconds`,
    );
  });
});

test('a late-evening offset-less datetime keeps its own date', () => {
  // The failure this guards against moves a commitment a day, not just hours.
  inEachZone((zone) => {
    assert.equal(
      parseIsoInstant('2026-08-23T23:30:00.000', 'dueDate').toISOString(),
      '2026-08-23T23:30:00.000Z',
      `[${zone}] late-evening offset-less datetime`,
    );
  });
});

test('an after-midnight offset-less datetime keeps its own date', () => {
  inEachZone((zone) => {
    assert.equal(
      parseIsoInstant('2026-08-23T00:30:00.000', 'dueDate').toISOString(),
      '2026-08-23T00:30:00.000Z',
      `[${zone}] after-midnight offset-less datetime`,
    );
  });
});

test('a date-only value keeps the UTC midnight meaning it already had', () => {
  inEachZone((zone) => {
    assert.equal(
      parseIsoInstant('2026-08-23', 'dueDate').toISOString(),
      '2026-08-23T00:00:00.000Z',
      `[${zone}] date-only value`,
    );
  });
});

test('a non-string or unparseable value still reports which field was wrong', () => {
  inEachZone((zone) => {
    assert.throws(() => parseIsoInstant(undefined, 'dueDate'), /dueDate/, `[${zone}] undefined dueDate`);
    assert.throws(() => parseIsoInstant('not a date', 'reminderTime'), /reminderTime/, `[${zone}] unparseable reminderTime`);
  });
});

test('an offset-less day key does not depend on the server zone', () => {
  // 23:30 UTC is already the next morning in Jerusalem. Read in the server's
  // zone instead, the same string landed on either day depending on the host.
  inEachZone((zone) => {
    assert.equal(
      localDayKey('2026-08-23T23:30:00', 'Asia/Jerusalem'),
      '2026-08-24',
      `[${zone}] offset-less localDayKey`,
    );
  });
});
