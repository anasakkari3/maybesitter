/**
 * What the review screen sends (UC-2.7b, #168).
 *
 * Two properties, and both are about not overstating what the user did:
 * nothing is ticked to begin with, and an "edit" that changed nothing is not
 * reported as an edit — because an edit is what turns a model's guess into
 * the user's own words on the memory screen.
 */
import { describe, expect, it } from '@jest/globals';
import { acceptedFrom, initialChoices, type ReviewChoice } from '../aboutYou';

const SUGGESTIONS = [
  { content: 'Finish the thesis' },
  { content: 'Studies late at night' },
  { content: 'Is a nursing student' },
];

function choices(overrides: Partial<ReviewChoice>[] = []): ReviewChoice[] {
  return initialChoices(SUGGESTIONS.length).map((choice, i) => ({ ...choice, ...overrides[i] }));
}

describe('the starting state', () => {
  it('has nothing ticked', () => {
    // A pre-ticked box would make "nothing persists without explicit
    // confirmation" false while still looking like a choice: the user would be
    // *unticking* to prevent something.
    expect(initialChoices(3)).toEqual([
      { accepted: false, edited: null },
      { accepted: false, edited: null },
      { accepted: false, edited: null },
    ]);
  });

  it('sends nothing from it', () => {
    expect(acceptedFrom(choices(), SUGGESTIONS)).toEqual([]);
  });
});

describe('what gets sent', () => {
  it('is only the ticked rows, by index', () => {
    const sent = acceptedFrom(choices([{ accepted: true }, {}, { accepted: true }]), SUGGESTIONS);
    expect(sent).toEqual([{ index: 0 }, { index: 2 }]);
  });

  it('carries a real edit', () => {
    const sent = acceptedFrom(
      choices([{ accepted: true, edited: 'Finish the dissertation' }]),
      SUGGESTIONS,
    );
    expect(sent).toEqual([{ index: 0, content: 'Finish the dissertation' }]);
  });

  it('does not report an edit that changed nothing', () => {
    // Opening the field and closing it is not writing the sentence. Sending it
    // as an edit would store the fact as the user's own words and make the
    // provenance chip claim they wrote something they did not.
    const sent = acceptedFrom(
      choices([{ accepted: true, edited: 'Finish the thesis' }]),
      SUGGESTIONS,
    );
    expect(sent).toEqual([{ index: 0 }]);
  });

  it('ignores whitespace-only edits the same way', () => {
    const sent = acceptedFrom(choices([{ accepted: true, edited: '   ' }]), SUGGESTIONS);
    expect(sent).toEqual([{ index: 0 }]);
  });

  it('trims a real edit before sending it', () => {
    const sent = acceptedFrom(choices([{ accepted: true, edited: '  Ship the app  ' }]), SUGGESTIONS);
    expect(sent).toEqual([{ index: 0, content: 'Ship the app' }]);
  });

  it('never sends an edit for a row that was not ticked', () => {
    // Editing without ticking is somebody trying a wording and deciding
    // against it.
    const sent = acceptedFrom(choices([{ accepted: false, edited: 'Something else' }]), SUGGESTIONS);
    expect(sent).toEqual([]);
  });
});
