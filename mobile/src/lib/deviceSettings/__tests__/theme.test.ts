import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { loadThemePref, parseThemePref, saveThemePref, THEME_STORAGE_KEY } from '../theme';

/**
 * The stored colour scheme (UC-1.R2, #155).
 *
 * #155 promised System / Light / Dark kept across launches; the screen held it
 * in React state, so every cold start came back as System. These tests are the
 * round trip that was missing.
 */
describe('the stored theme preference', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('accepts the three the picker offers', () => {
    expect(parseThemePref('system')).toBe('system');
    expect(parseThemePref('light')).toBe('light');
    expect(parseThemePref('dark')).toBe('dark');
  });

  it('discards anything else rather than trusting the store', () => {
    // Only a corrupted store or an older build can put these here, and
    // rendering a scheme nobody chose is worse than following the system.
    for (const bad of ['Dark', 'auto', '', ' ', 'null', 'undefined', 'true']) {
      expect(parseThemePref(bad)).toBeNull();
    }
    expect(parseThemePref(null)).toBeNull();
  });

  it('trims what a store may have padded', () => {
    expect(parseThemePref('  dark  ')).toBe('dark');
  });

  it('is versioned, so a later shape can be told apart', () => {
    expect(THEME_STORAGE_KEY).toBe('settings.theme.v1');
  });

  it('reads back what was written — the round trip the app restarts through', async () => {
    await saveThemePref('dark');
    await expect(loadThemePref()).resolves.toBe('dark');

    await saveThemePref('light');
    await expect(loadThemePref()).resolves.toBe('light');

    await saveThemePref('system');
    await expect(loadThemePref()).resolves.toBe('system');
  });

  it('falls back to the system on a store that has never been written', async () => {
    await expect(loadThemePref()).resolves.toBe('system');
  });

  it('falls back to the system rather than honouring a corrupted value', async () => {
    await AsyncStorage.setItem(THEME_STORAGE_KEY, 'midnight');
    await expect(loadThemePref()).resolves.toBe('system');
  });
});
