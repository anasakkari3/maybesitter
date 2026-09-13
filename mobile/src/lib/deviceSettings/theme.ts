import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ThemePref } from '../../state/types';

/**
 * Which colour scheme the app renders in (UC-1.R2, #155).
 *
 * ── On the device, not the account ───────────────────────────────
 *
 * The same argument the language preference makes, for the same reason it is
 * allowed here: this is not content, and it has to survive a relaunch. It is
 * one of three enum values about how a screen looks — it says nothing about
 * what the person committed to, who they know, or when they sleep.
 *
 * It is a *device* fact rather than an account one on purpose. Somebody may
 * want dark on the phone they read in bed and system on the tablet, and the
 * scheme a screen should use is a property of the screen they are looking at.
 * A second device follows that device's system setting until told otherwise.
 *
 * A stored value that is not one of the three is discarded rather than
 * trusted: it can only come from a corrupted store or an older build, and
 * rendering a scheme nobody chose is worse than falling back to the system.
 */
export const THEME_STORAGE_KEY = 'settings.theme.v1';

const VALUES: readonly string[] = ['system', 'light', 'dark'];

export function parseThemePref(raw: string | null): ThemePref | null {
  const value = (raw ?? '').trim();
  return VALUES.includes(value) ? (value as ThemePref) : null;
}

/** The stored choice, or 'system' when there is none to read. */
export async function loadThemePref(): Promise<ThemePref> {
  try {
    return parseThemePref(await AsyncStorage.getItem(THEME_STORAGE_KEY)) ?? 'system';
  } catch {
    // A store that cannot be read is the same as one never written: follow the
    // device rather than failing the first render.
    return 'system';
  }
}

export async function saveThemePref(pref: ThemePref): Promise<void> {
  try {
    await AsyncStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // The choice still applies for this session. Losing it on the next launch
    // is a smaller failure than a theme switch that appears not to work.
  }
}
