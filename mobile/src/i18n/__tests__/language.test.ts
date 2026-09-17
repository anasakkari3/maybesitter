import { beforeEach, describe, expect, it } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LANGUAGE_STORAGE_KEY, loadLanguagePref, loadLanguagePrefState } from '../language';

/**
 * Whether a language was ever chosen is a separate bit from which one (#469).
 *
 * `'system'` is both the default and a legal explicit choice, so the value
 * alone cannot tell a fresh install from someone who picked "System" on
 * purpose. The gate that shows the language screen before sign-in has to
 * know the difference, and the difference is whether the key exists.
 */
describe('loadLanguagePrefState', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('reports nothing chosen on a fresh install', async () => {
    await expect(loadLanguagePrefState()).resolves.toEqual({ pref: 'system', chosen: false });
  });

  it('counts an explicit "system" as a choice', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'system');
    await expect(loadLanguagePrefState()).resolves.toEqual({ pref: 'system', chosen: true });
  });

  it('returns a stored language as chosen', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'he');
    await expect(loadLanguagePrefState()).resolves.toEqual({ pref: 'he', chosen: true });
  });

  it('treats a value it does not recognise as never chosen', async () => {
    // Only a corrupted store writes this. Asking again beats trusting it.
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'klingon');
    await expect(loadLanguagePrefState()).resolves.toEqual({ pref: 'system', chosen: false });
  });

  it('keeps the plain loader for existing callers', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await expect(loadLanguagePref()).resolves.toBe('ar');
  });
});
