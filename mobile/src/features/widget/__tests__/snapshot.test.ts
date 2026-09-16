/**
 * The home-screen widget's snapshot (UC-3.R1, #203).
 *
 * The claim worth most here is the privacy one: with the default setting, the
 * JSON that leaves the app sandbox for the App Group / the widget store does
 * not contain a commitment title *anywhere* — not in `title`, not in a label,
 * not in a link. So the assertions search the serialised string, which is the
 * exact bytes the native side would receive, rather than one field of it.
 */
import { describe, expect, it } from '@jest/globals';
import {
  SNAPSHOT_TTL_MS,
  buildSnapshot,
  displayStateOf,
  widgetLinks,
  type SnapshotInput,
  type WidgetLabels,
} from '../snapshot';
import type { Commitment } from '../../../api/schemas/common';

const NOW = new Date('2026-09-13T09:00:00.000Z');

const LABELS: WidgetLabels = {
  privateCommitment: 'Private commitment',
  nextStep: 'Next step',
  empty: 'Nothing open right now.',
  capture: 'Say it',
  stale: 'Open MaybeSitter to refresh.',
};

function commitment(overrides: Partial<Commitment> & { id: string }): Commitment {
  return {
    kind: 'task',
    title: overrides.title ?? overrides.id,
    // Private text that has no business on a home screen under any setting.
    description: 'SECRET-DESCRIPTION نص خاص',
    person: 'SECRET-PERSON סבתא',
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    category: null,
    categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: '2026-09-13T12:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    confirmedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null,
    droppedAt: null,
    ...overrides,
    id: overrides.id,
  } as Commitment;
}

const level = (l: 'high' | 'normal' | 'low') =>
  ({ level: l, source: 'default', pressureAllowed: false, pressureLevel: 'none' }) as Commitment['priority'];

const at = (iso: string | null) =>
  ({ kind: 'due_by', dueAt: iso, endAt: null, remindAt: null, allDay: false, timezone: 'UTC' }) as Commitment['timeSpec'];

// Titles in all three primary languages, so "the real text is absent" is not
// only an ASCII claim.
const TODAY: Commitment[] = [
  commitment({ id: 'nice-early', title: 'Water the plants', priority: level('low'), timeSpec: at('2026-09-13T08:00:00.000Z') }),
  commitment({ id: 'must-late', title: 'موعد الدكتور', priority: level('high'), timeSpec: at('2026-09-13T15:00:00.000Z') }),
  commitment({ id: 'should-mid', title: 'להתקשר לסבתא', priority: level('normal'), timeSpec: at('2026-09-13T11:00:00.000Z') }),
  commitment({ id: 'must-early', title: 'Pay the rent', priority: level('high'), timeSpec: at('2026-09-13T10:00:00.000Z') }),
  commitment({ id: 'done', title: 'Already finished thing', status: 'completed', priority: level('high') }),
];

function input(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    today: TODAY,
    nextStep: { commitmentId: 'should-mid', title: 'להתקשר לסבתא' },
    titlesAllowed: false,
    surface: 'widget',
    locale: 'en',
    labels: LABELS,
    now: NOW,
    formatTime: (date) => date.toISOString().slice(11, 16),
    ...overrides,
  };
}

const REAL_TITLES = ['Water the plants', 'موعد الدكتور', 'להתקשר לסבתא', 'Pay the rent', 'Already finished thing'];

describe('buildSnapshot — the privacy default', () => {
  it('writes no real title anywhere in the serialised snapshot', () => {
    const json = JSON.stringify(buildSnapshot(input()));
    for (const title of REAL_TITLES) expect(json).not.toContain(title);
    // And it is not an empty snapshot passing by accident.
    const snapshot = buildSnapshot(input());
    expect(snapshot.items).toHaveLength(3);
    for (const item of snapshot.items) {
      expect(item.title).toBe(LABELS.privateCommitment);
      expect(item.titleRedacted).toBe(true);
      expect(item.redactionReason).toBe('titlesNotAllowed');
    }
    expect(snapshot.titlePrivacy).toEqual({ mode: 'neverIncludeTitles', allowedSurfaceIds: [] });
  });

  it('redacts the next step, whose title arrives separately from the list', () => {
    const snapshot = buildSnapshot(input({ today: [], nextStep: { commitmentId: 'x1', title: 'موعد الدكتور' } }));
    expect(snapshot.items).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain('موعد الدكتور');
  });

  it('keeps priority and time when it hides the title', () => {
    const [first] = buildSnapshot(input()).items;
    expect(first).toMatchObject({ id: 'should-mid', priority: 'should', timeLabel: '11:00' });
  });
});

describe('buildSnapshot — exactly these fields leave the app', () => {
  const ITEM_KEYS = ['category', 'dueAt', 'id', 'isNextStep', 'link', 'priority', 'redactionReason', 'timeLabel', 'title', 'titleRedacted'];

  it('writes each item with exactly the contract keys, in both privacy modes', () => {
    for (const titlesAllowed of [false, true]) {
      const snapshot = buildSnapshot(input({ titlesAllowed }));
      for (const item of snapshot.items) expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
      expect(Object.keys(snapshot).sort()).toEqual([
        'contract', 'direction', 'expiresAt', 'generatedAt', 'items', 'labels', 'links', 'locale', 'schemaVersion', 'surface', 'titlePrivacy',
      ]);
    }
  });

  it('never writes a description or a person, even with titles allowed', () => {
    const json = JSON.stringify(buildSnapshot(input({ titlesAllowed: true })));
    expect(json).not.toContain('SECRET-DESCRIPTION');
    expect(json).not.toContain('SECRET-PERSON');
  });
});

describe('buildSnapshot — the opt-in', () => {
  it('writes the titles for the surface the user allowed', () => {
    const snapshot = buildSnapshot(input({ titlesAllowed: true }));
    expect(snapshot.items.map((item) => item.title)).toEqual(['להתקשר לסבתא', 'Pay the rent', 'موعد الدكتور']);
    expect(snapshot.items.every((item) => !item.titleRedacted && item.redactionReason === null)).toBe(true);
    expect(snapshot.titlePrivacy).toEqual({ mode: 'allowedSurfacesOnly', allowedSurfaceIds: ['widget'] });
  });

  it('never gives the lock screen a title, even after the opt-in', () => {
    const snapshot = buildSnapshot(input({ titlesAllowed: true, surface: 'lockScreen' }));
    const json = JSON.stringify(snapshot);
    for (const title of REAL_TITLES) expect(json).not.toContain(title);
    expect(snapshot.titlePrivacy.allowedSurfaceIds).not.toContain('lockScreen');
    // And the home-screen snapshot the lock-screen families also read does not allow them either.
    expect(buildSnapshot(input({ titlesAllowed: true })).titlePrivacy.allowedSurfaceIds).not.toContain('lockScreen');
  });

  it('still redacts for a surface that is not in the allowed list', () => {
    const json = JSON.stringify(buildSnapshot(input({ titlesAllowed: true, surface: 'watch' as never })));
    for (const title of REAL_TITLES) expect(json).not.toContain(title);
  });
});

describe('buildSnapshot — what is shown, and in what order', () => {
  it('puts the next step first, then must → should → nice, then time, and at most three', () => {
    const snapshot = buildSnapshot(input({ nextStep: { commitmentId: 'nice-early', title: 'Water the plants' } }));
    expect(snapshot.items.map((item) => item.id)).toEqual(['nice-early', 'must-early', 'must-late']);
    expect(snapshot.items.map((item) => item.isNextStep)).toEqual([true, false, false]);
  });

  it('orders by the list alone when there is no next step', () => {
    const snapshot = buildSnapshot(input({ nextStep: null }));
    expect(snapshot.items.map((item) => item.id)).toEqual(['must-early', 'must-late', 'should-mid']);
    expect(snapshot.items.some((item) => item.isNextStep)).toBe(false);
  });

  it('breaks a tie on time by title, and puts untimed items after timed ones', () => {
    const snapshot = buildSnapshot(input({
      nextStep: null,
      today: [
        commitment({ id: 'b', title: 'b', priority: level('high'), timeSpec: at(null) }),
        commitment({ id: 'z', title: 'z', priority: level('high'), timeSpec: at('2026-09-13T10:00:00.000Z') }),
        commitment({ id: 'a', title: 'a', priority: level('high'), timeSpec: at('2026-09-13T10:00:00.000Z') }),
      ],
    }));
    expect(snapshot.items.map((item) => item.id)).toEqual(['a', 'z', 'b']);
  });

  it('never shows a finished item', () => {
    const snapshot = buildSnapshot(input({ nextStep: null, today: [TODAY[4]!] }));
    expect(snapshot.items).toEqual([]);
  });

  it('draws no time for an all-day item', () => {
    const allDay = commitment({ id: 'd', timeSpec: { ...at('2026-09-13T00:00:00.000Z'), allDay: true } });
    expect(buildSnapshot(input({ nextStep: null, today: [allDay] })).items[0]!.timeLabel).toBeNull();
  });

  it('expires thirty minutes after it was made, and carries the contract header', () => {
    const snapshot = buildSnapshot(input());
    expect(SNAPSHOT_TTL_MS).toBe(30 * 60 * 1000);
    expect(snapshot).toMatchObject({
      contract: 'commitmentSnapshot',
      schemaVersion: 1,
      generatedAt: '2026-09-13T09:00:00.000Z',
      expiresAt: '2026-09-13T09:30:00.000Z',
      surface: 'widget',
    });
  });

  it('carries the direction the widget has to lay out in', () => {
    expect(buildSnapshot(input({ locale: 'ar' })).direction).toBe('rtl');
    expect(buildSnapshot(input({ locale: 'he' })).direction).toBe('rtl');
    expect(buildSnapshot(input({ locale: 'en' })).direction).toBe('ltr');
  });

  it('links each item to itself, and the empty state to voice capture', () => {
    const snapshot = buildSnapshot(input());
    expect(snapshot.items[0]!.link).toBe('maybesitter://commitments/should-mid');
    expect(snapshot.links).toEqual({ capture: 'maybesitter://capture?source=widget&input=voice', today: 'maybesitter://today' });
    expect(widgetLinks.commitment('abc')).toBe('maybesitter://commitments/abc');
  });

  it('drops a next step whose id could not survive the deep-link parser', () => {
    const snapshot = buildSnapshot(input({ today: [], nextStep: { commitmentId: '../../etc', title: 'Pay the rent' } }));
    expect(snapshot.items).toEqual([]);
  });

  it('drops an item whose id could not survive the deep-link parser rather than writing a broken link', () => {
    const snapshot = buildSnapshot(input({ nextStep: null, today: [commitment({ id: '../etc', priority: level('high') })] }));
    expect(snapshot.items).toEqual([]);
  });
});

describe('displayStateOf', () => {
  it('is loading with no snapshot, empty with no items, stale once expired, populated otherwise', () => {
    expect(displayStateOf(null, NOW)).toBe('loading');
    const populated = buildSnapshot(input());
    expect(displayStateOf(populated, NOW)).toBe('populated');
    expect(displayStateOf(buildSnapshot(input({ today: [], nextStep: null })), NOW)).toBe('empty');
    expect(displayStateOf(populated, new Date(NOW.getTime() + SNAPSHOT_TTL_MS))).toBe('stale');
    expect(displayStateOf(populated, new Date(NOW.getTime() + SNAPSHOT_TTL_MS - 1))).toBe('populated');
  });

  it('treats an unreadable snapshot as no snapshot', () => {
    expect(displayStateOf({ contract: 'something else' } as never, NOW)).toBe('loading');
  });
});
