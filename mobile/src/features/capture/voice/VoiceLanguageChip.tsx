import React from 'react';
import { useApp } from '../../../state/AppContext';
import { Btn, Txt } from '../../../ui/primitives';
import type { SpeechLanguagePref } from '../../../lib/deviceSettings/speechLanguage';

/**
 * Which language the mic listens for (UC-2.3 #163 step 5).
 *
 * Named in itself — عربي / עברית / English — never translated, for the same
 * reason `LANGUAGE_ENDONYM` exists in Settings: somebody looking for their own
 * language finds it by its own name, not by what the current UI calls it.
 *
 * Only shown when there is a recogniser. A language chooser above a mic that
 * cannot listen is a setting for nothing.
 */
const ENDONYM: Record<SpeechLanguagePref, string> = {
  ar: 'عربي',
  he: 'עברית',
  en: 'English',
};

const ORDER: readonly SpeechLanguagePref[] = ['ar', 'he', 'en'];

export function VoiceLanguageChip({
  value,
  onChange,
}: {
  value: SpeechLanguagePref;
  onChange(next: SpeechLanguagePref): void;
}) {
  const { p } = useApp();
  const next = ORDER[(ORDER.indexOf(value) + 1) % ORDER.length]!;

  return (
    <Btn
      testID="voice-language"
      // The label names the current language and what tapping does, because
      // "عربي" alone tells a screen-reader user nothing about the control.
      label={`${ENDONYM[value]} → ${ENDONYM[next]}`}
      onPress={() => onChange(next)}
      style={{ backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, minHeight: 40, justifyContent: 'center' }}
    >
      <Txt size={13} weight={600}>{ENDONYM[value]}</Txt>
    </Btn>
  );
}
