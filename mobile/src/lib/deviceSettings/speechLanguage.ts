import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Which language the recogniser is asked for (UC-2.3, #163).
 *
 * ── On the device, not the account ───────────────────────────────
 *
 * The app's language is a preference that should follow somebody to a new
 * phone. Which language they *dictate* in is a fact about this device: the
 * recognisers installed on it, the keyboard they use, and often the room they
 * are in. Somebody whose app is in Arabic may still dictate English at work.
 *
 * It defaults to the app language, so nobody has to choose before the mic
 * works. A stored value that is not one of the three is discarded rather than
 * trusted — it can only come from a corrupted store or an older build.
 */
export const SPEECH_LANGUAGE_KEY = 'speech.language.v1';

export type SpeechLanguagePref = 'ar' | 'he' | 'en';

const VALUES: readonly string[] = ['ar', 'he', 'en'];

export function parseSpeechLanguage(raw: string | null): SpeechLanguagePref | null {
  const value = (raw ?? '').trim();
  return VALUES.includes(value) ? (value as SpeechLanguagePref) : null;
}

export async function loadSpeechLanguage(): Promise<SpeechLanguagePref | null> {
  try {
    return parseSpeechLanguage(await AsyncStorage.getItem(SPEECH_LANGUAGE_KEY));
  } catch {
    // A store that cannot be read is the same as one that has never been
    // written: fall back to the app language rather than failing the mic.
    return null;
  }
}

export async function saveSpeechLanguage(value: SpeechLanguagePref): Promise<void> {
  try {
    await AsyncStorage.setItem(SPEECH_LANGUAGE_KEY, value);
  } catch {
    // The choice still applies for this session. Losing it on the next launch
    // is a smaller failure than a mic that refuses to start.
  }
}
