import { useEffect, useState } from 'react';
import { getCalendars } from 'expo-localization';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * Where an unknown or unreadable device timezone lands. UTC, never a region:
 * the Flutter client defaulted to 'Asia/Jerusalem' and silently showed the
 * wrong wall time to anyone outside Israel. UTC is obviously wrong instead of
 * quietly wrong, and the backend already accepts it.
 */
export const FALLBACK_TIME_ZONE = 'UTC';

/** True when `Intl` recognises the IANA name — the only check that matters. */
export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(raw: string | null | undefined): string {
  return isValidTimeZone(raw) ? raw : FALLBACK_TIME_ZONE;
}

/** The device's IANA timezone, validated, or UTC. */
export function deviceTimeZone(): string {
  try {
    return resolveTimeZone(getCalendars()[0]?.timeZone);
  } catch {
    // getCalendars() is a native call; a failure there must not take a screen
    // down over a timezone.
    return FALLBACK_TIME_ZONE;
  }
}

/**
 * The device timezone, re-read whenever the app comes back to the foreground.
 * A user who changes it in Settings, or who flies somewhere, gets the new zone
 * on the next 'active' without a restart.
 */
export function useTimeZone(): string {
  const [timeZone, setTimeZone] = useState(deviceTimeZone);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state !== 'active') return;
      const next = deviceTimeZone();
      setTimeZone(current => (current === next ? current : next));
    });
    return () => sub.remove();
  }, []);
  return timeZone;
}
