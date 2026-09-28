import { describe, expect, it } from '@jest/globals';
import { appendDictation, joinSegments } from '../dictationText';

/**
 * Dictation adds to the field; it does not replace it (owner's first iPhone
 * run: speaking wiped what had been typed).
 */
describe('appendDictation', () => {
  it('puts the words in an empty field as they are', () => {
    expect(appendDictation('', 'call Dana')).toBe('call Dana');
    expect(appendDictation('   ', ' call Dana')).toBe('call Dana');
  });

  it('adds one space between what was typed and what was said', () => {
    expect(appendDictation('A', 'B c')).toBe('A B c');
  });

  it("does not double a space the user already typed, or break their new line", () => {
    expect(appendDictation('A ', 'B')).toBe('A B');
    expect(appendDictation('A\n', 'B')).toBe('A\nB');
  });

  it('drops the leading space iOS 18 puts on a later segment', () => {
    expect(appendDictation('A', ' B')).toBe('A B');
  });

  it('returns the field untouched for an empty transcript', () => {
    expect(appendDictation('A', '')).toBe('A');
    expect(appendDictation('A', '   ')).toBe('A');
  });

  it('works for Arabic the same way', () => {
    expect(appendDictation('ذكرني', 'أسلم التقرير بكرا')).toBe('ذكرني أسلم التقرير بكرا');
  });
});

describe('joinSegments', () => {
  it('joins the finished parts of one dictation with single spaces', () => {
    expect(joinSegments('', 'remind me')).toBe('remind me');
    expect(joinSegments('remind me', ' to call Dana')).toBe('remind me to call Dana');
    expect(joinSegments('remind me', '')).toBe('remind me');
  });
});
