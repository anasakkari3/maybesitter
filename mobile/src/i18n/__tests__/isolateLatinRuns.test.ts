import { describe, expect, it } from '@jest/globals';
import { isolateAuto, isolateLatinRuns, stripIsolates } from '../bidi';
import ar from '../locales/ar.json';
import he from '../locales/he.json';
import en from '../locales/en.json';

describe('isolateLatinRuns (chat UAT 2026-09-30: the AI disclosure)', () => {
  it('isolates each brand run whole inside Arabic and Hebrew, so "(Vertex AI)" is not split', () => {
    const arabic = isolateLatinRuns(ar.aiDisclosure);
    expect(arabic).toContain(`لـ${isolateAuto('Gemini')}`);
    expect(arabic).toContain(isolateAuto('Google (Vertex AI)'));
    expect(stripIsolates(arabic)).toBe(ar.aiDisclosure);
    const hebrew = isolateLatinRuns(he.aiDisclosure);
    expect(hebrew).toContain(isolateAuto('Gemini'));
    expect(hebrew).toContain(isolateAuto('(Vertex AI)'));
    expect(stripIsolates(hebrew)).toBe(he.aiDisclosure);
  });

  it('leaves Latin-only text as it is', () => {
    expect(isolateLatinRuns(en.aiDisclosure)).toBe(en.aiDisclosure);
  });
});
