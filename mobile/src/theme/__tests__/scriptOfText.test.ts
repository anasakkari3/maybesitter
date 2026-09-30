/** Which face the person's own words need, whatever the UI's language (UAT 2026-09-30, u27). */
import { describe, expect, it } from '@jest/globals';
import { scriptOfText } from '../fonts';

describe('scriptOfText', () => {
  it('Latin letters alone take the Latin face in an Arabic or Hebrew UI', () => {
    expect(scriptOfText('Dentist tomorrow at 5pm', 'arabic')).toBe('latin');
    expect(scriptOfText('Call mom', 'hebrew')).toBe('latin');
  });
  it('any Arabic or Hebrew letter keeps that face (it covers Latin too)', () => {
    expect(scriptOfText('موعد مع Sami', 'arabic')).toBe('arabic');
    expect(scriptOfText('פגישה עם Dana', 'arabic')).toBe('hebrew');
    expect(scriptOfText('موعد', 'latin')).toBe('arabic');
  });
  it('digits, punctuation and nothing say nothing: the UI face stays', () => {
    expect(scriptOfText('', 'arabic')).toBe('arabic');
    expect(scriptOfText('10:00 - 16:00', 'hebrew')).toBe('hebrew');
  });
});
