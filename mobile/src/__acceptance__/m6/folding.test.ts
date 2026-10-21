import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

interface FoldingFixtures {
  fold: [input: string, expected: string][];
  wordPrefix: [haystack: string, needle: string, expected: boolean][];
  emptyAfterFold: string[];
}

function implementation(): {
  foldForSearch: (text: string) => string;
  isWordPrefixMatch: (haystack: string, needle: string) => boolean;
} {
  return jest.requireActual('../../text/foldForSearch');
}

function fixtures(): FoldingFixtures {
  const path = join(__dirname, '..', '..', 'text', 'foldForSearch.fixtures.json');
  return JSON.parse(readFileSync(path, 'utf8')) as FoldingFixtures;
}

describe('M6 shared search folding', () => {
  it('R54.2 parity folds every shared fixture identically on mobile', () => {
    const { foldForSearch } = implementation();
    for (const [input, expected] of fixtures().fold) expect(foldForSearch(input)).toBe(expected);
    for (const input of fixtures().emptyAfterFold) expect(foldForSearch(input)).toBe('');
  });

  it('M6A-R4-005 parity folds both operands before the shared word-prefix predicate', () => {
    const { foldForSearch, isWordPrefixMatch } = implementation();
    for (const [haystack, needle, expected] of fixtures().wordPrefix) {
      expect(isWordPrefixMatch(foldForSearch(haystack), foldForSearch(needle))).toBe(expected);
    }
  });
});

