import { describe, expect, it } from '@jest/globals';
import { parseSpeechLanguage, SPEECH_LANGUAGE_KEY } from '../speechLanguage';

/**
 * Which language the mic listens for (UC-2.3, #163).
 *
 * On the device, not the account: the recognisers installed on this phone, the
 * keyboard, often the room. Somebody whose app is in Arabic may still dictate
 * English at work.
 */
describe('the stored speech language', () => {
  it('accepts the three the product speaks', () => {
    expect(parseSpeechLanguage('ar')).toBe('ar');
    expect(parseSpeechLanguage('he')).toBe('he');
    expect(parseSpeechLanguage('en')).toBe('en');
  });

  it('discards anything else rather than trusting the store', () => {
    // A value here can only come from a corrupted store or an older build, and
    // handing it to the recogniser would ask for a language nobody chose.
    for (const bad of ['fr', 'ar-JO', '', ' ', 'AR', 'null', 'undefined']) {
      expect(parseSpeechLanguage(bad)).toBeNull();
    }
    expect(parseSpeechLanguage(null)).toBeNull();
  });

  it('trims what a store may have padded', () => {
    expect(parseSpeechLanguage('  he  ')).toBe('he');
  });

  it('is versioned, so a later shape can be told apart', () => {
    expect(SPEECH_LANGUAGE_KEY).toBe('speech.language.v1');
  });
});
