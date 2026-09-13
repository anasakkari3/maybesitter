import { describe, expect, it } from '@jest/globals';
import { rowAccessibilityLabel } from '../accessibility';
import type { CommitmentView } from '../model';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';

/**
 * What a screen reader says about one row (UC-2.R3 #173 step 8).
 *
 * Before this the row announced its title and nothing else, so every signal
 * the design added to help someone triage their day — Must, the time, the
 * estimated mark — was visual only.
 */
const asStrings = (locale: object) => locale as unknown as Record<string, string>;
const EN = asStrings(en) as unknown as Parameters<typeof rowAccessibilityLabel>[1];
const AR = asStrings(ar) as unknown as Parameters<typeof rowAccessibilityLabel>[1];

function view(over: Partial<CommitmentView> = {}): CommitmentView {
  return {
    id: 'c1',
    title: 'Send the report',
    importance: 'must',
    status: 'active',
    shownAt: '2026-09-13T15:00:00.000Z',
    isPast: false,
    importanceIsStated: true,
    rank: 0,
    reasonCodes: [],
    ...over,
  };
}

describe('the row announces everything it shows', () => {
  it('names the title, the importance and the time', () => {
    const label = rowAccessibilityLabel(view(), EN, '18:00');
    expect(label).toBe(`Send the report, ${en.todayGroupMust}, 18:00`);
  });

  it('says there is no time rather than leaving it out', () => {
    // An omission is indistinguishable from a bug to somebody who cannot see
    // the row.
    expect(rowAccessibilityLabel(view({ shownAt: null }), EN, null))
      .toContain(en.noTimeYet);
  });

  it('marks an importance that was read off their words', () => {
    expect(rowAccessibilityLabel(view({ importanceIsStated: false }), EN, '18:00'))
      .toContain(en.todayEstimatedMark);
  });

  it('does not say estimated about something the user set', () => {
    // The announcement contradicting the screen is worse than a short label.
    expect(rowAccessibilityLabel(view({ importanceIsStated: true }), EN, '18:00'))
      .not.toContain(en.todayEstimatedMark);
  });

  it('names a finished state, and distinguishes the two', () => {
    expect(rowAccessibilityLabel(view({ status: 'done' }), EN, '18:00')).toContain(en.doneS);
    expect(rowAccessibilityLabel(view({ status: 'dropped' }), EN, '18:00')).toContain(en.dropped);
    expect(rowAccessibilityLabel(view({ status: 'done' }), EN, '18:00')).not.toContain(en.dropped);
  });

  it('says nothing about status for a live row', () => {
    const label = rowAccessibilityLabel(view(), EN, '18:00');
    expect(label).not.toContain(en.doneS);
    expect(label).not.toContain(en.dropped);
  });
});

describe('it speaks the language the screen speaks', () => {
  it('uses the same words the row draws, in Arabic', () => {
    // Not a second vocabulary. A reader saying "high priority" while the
    // screen says «لازم» is the two drifting.
    const label = rowAccessibilityLabel(view(), AR, '18:00');
    expect(label).toContain(ar.todayGroupMust);
    expect(label).not.toContain(en.todayGroupMust);
  });
});

describe('the shape of it', () => {
  it('separates the parts so a reader pauses between them', () => {
    expect(rowAccessibilityLabel(view(), EN, '18:00').split(', ').length).toBe(3);
  });

  it('leads with the title, which is how the person identifies the row', () => {
    expect(rowAccessibilityLabel(view(), EN, '18:00').startsWith('Send the report')).toBe(true);
  });
});
