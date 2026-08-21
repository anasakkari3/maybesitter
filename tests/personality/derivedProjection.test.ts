/**
 * The cold path's privacy boundary, tested as a structural property rather
 * than a type-level promise.
 *
 * A TypeScript interface proves nothing once the code runs: an input object
 * with extra keys satisfies `ProjectionEvent` and would ride along through any
 * spread. So these tests do not merely check that three known sample titles
 * are absent — they feed the builder events carrying unexpected text-bearing
 * properties with distinctive sentinel values and assert that the serialized
 * projection contains none of them.
 *
 * The sensitive-title fixtures are Arabic, Hebrew and English because those
 * are the product's languages, and a leak check that only greps ASCII would
 * pass while an Arabic diagnosis walked out of the device.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDerivedProjection,
  projectionCarriesNoText,
  projectionIsSendable,
  UNCLASSIFIED_KIND,
  type DerivedProjection,
} from '../../src/personality/derivedProjection.ts';

const window = { from: new Date('2026-08-01'), to: new Date('2026-08-21') };

/** Arabic, Hebrew and English titles, each naming something private. */
const AR_TITLE = 'موعد علاج الأورام في المستشفى';
const HE_TITLE = 'בדיקת אונקולוגיה בבית החולים';
const EN_TITLE = 'oncology scan';

const events = [
  { kind: 'medical', completedAt: new Date('2026-08-05T15:00:00Z'), dropped: false, title: EN_TITLE },
  { kind: 'work', completedAt: new Date('2026-08-06T09:00:00Z'), dropped: false, title: 'standup' },
  { kind: 'work', completedAt: null, dropped: true, title: 'report' },
];

test('the projection counts by kind', () => {
  const p = buildDerivedProjection(events, window);
  assert.equal(p.byKind.work, 2);
  assert.equal(p.byKind.medical, 1);
});

test('the projection records completion hours, not timestamps', () => {
  const p = buildDerivedProjection(events, window);
  // Numeric comparator: the default sort is lexicographic and would order
  // [9, 15] as [15, 9].
  assert.deepEqual([...p.completionHours].sort((a, b) => a - b), [9, 15]);
});

test('no title survives into the projection — Arabic, Hebrew or English', () => {
  const serialised = JSON.stringify(
    buildDerivedProjection(
      [
        { kind: 'medical', completedAt: new Date('2026-08-05T15:00:00Z'), dropped: false, title: AR_TITLE },
        { kind: 'medical', completedAt: new Date('2026-08-06T09:00:00Z'), dropped: false, title: HE_TITLE },
        { kind: 'medical', completedAt: null, dropped: true, title: EN_TITLE },
      ],
      window,
    ),
  );

  for (const title of [AR_TITLE, HE_TITLE, EN_TITLE]) {
    assert.ok(!serialised.includes(title), `a title leaked into the cold path: ${title}`);
  }
  // Also check a distinctive fragment, in case a leak truncated the title.
  assert.ok(!serialised.includes('الأورام'), 'an Arabic fragment leaked');
  assert.ok(!serialised.includes('אונקולוגיה'), 'a Hebrew fragment leaked');
  assert.ok(!serialised.includes('oncology'), 'an English fragment leaked');
});

test('text-bearing properties the type never declared are still not copied', () => {
  // Each value is a distinctive sentinel so a match below is unambiguous.
  const sentinels = {
    notes: 'SENTINEL_NOTES_a41f',
    description: 'SENTINEL_DESCRIPTION_b52c',
    personName: 'SENTINEL_PERSON_c63d',
    rawText: 'SENTINEL_RAWTEXT_d74e',
    message: 'SENTINEL_MESSAGE_e85f',
    __note: 'SENTINEL_DUNDER_f96a',
    title: 'SENTINEL_TITLE_0a7b',
  };

  const serialised = JSON.stringify(
    buildDerivedProjection(
      [
        { kind: 'medical', completedAt: new Date('2026-08-05T15:00:00Z'), dropped: false, ...sentinels },
        { kind: 'work', completedAt: new Date('2026-08-06T09:00:00Z'), dropped: false, ...sentinels },
        { kind: 'work', completedAt: null, dropped: true, ...sentinels },
      ],
      window,
    ),
  );

  for (const [property, value] of Object.entries(sentinels)) {
    assert.ok(!serialised.includes(value), `the ${property} property reached the cold path`);
  }
});

test('the projection has exactly the allowed keys and nothing else', () => {
  // Explicit construction is what keeps the boundary true; an unexpected key
  // here means something was copied rather than built.
  const p = buildDerivedProjection(events, window);
  assert.deepEqual(Object.keys(p).sort(), [
    'byKind',
    'completed',
    'completionHours',
    'dropped',
    'observations',
    'window',
  ]);
});

test('a kind that is free text is bucketed, not carried through', () => {
  // `kind` is typed `string`, so nothing stops a caller from passing a title
  // in it. byKind keys become part of the payload, so they are constrained.
  const p = buildDerivedProjection(
    [
      { kind: AR_TITLE, completedAt: null, dropped: false },
      { kind: 'work', completedAt: null, dropped: false },
    ],
    window,
  );

  assert.equal(p.byKind[UNCLASSIFIED_KIND], 1);
  assert.ok(!JSON.stringify(p).includes('الأورام'), 'a title leaked through the kind key');
});

test('a projection below the observation floor is not sendable', () => {
  const p = buildDerivedProjection([events[0]], window);
  assert.equal(projectionIsSendable(p), false);
});

test('a projection at the floor is sendable', () => {
  const p = buildDerivedProjection(events, window);
  assert.equal(projectionIsSendable(p), true);
});

test('sendable means no-text as well as enough observations', () => {
  // The guard is asked about projections that were persisted and read back,
  // not only ones this process just built. If it only counted observations
  // its name would promise a check it never performs.
  const leaky = buildDerivedProjection(events, window) as DerivedProjection & { notes?: string };
  leaky.notes = 'SENTINEL_LEAK_11c2';

  assert.equal(projectionCarriesNoText(leaky), false);
  assert.equal(projectionIsSendable(leaky), false, 'an extra text key must block the send');
});

test('a byKind key holding a sentence blocks the send', () => {
  const leaky = buildDerivedProjection(events, window);
  leaky.byKind = { [EN_TITLE]: 3 };

  assert.equal(projectionIsSendable(leaky), false);
});

test('a completion hour outside a day blocks the send', () => {
  // Out-of-range numbers mean the field was filled by something other than
  // this builder, so the rest of the payload is not trustworthy either.
  const bad = buildDerivedProjection(events, window);
  bad.completionHours = [9, 47];

  assert.equal(projectionIsSendable(bad), false);
});
