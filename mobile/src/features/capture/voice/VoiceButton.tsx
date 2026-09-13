import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../../state/AppContext';
import { Btn, Txt } from '../../../ui/primitives';
import { MicIcon } from '../../../ui/icons';
import { Waveform } from '../../../ui/motion';
import {
  noopSpeechCaptureService,
  type SpeechCaptureService,
  type SpeechStatus,
} from './SpeechCaptureService';

/**
 * The mic, and the seam the recogniser plugs into (UC-2.R2 #172 step 9).
 *
 * ── It renders nothing until there is a recogniser ───────────────
 *
 * The default service is `NoopSpeechCaptureService`, which reports
 * `unavailable`, and an unavailable service means no button at all — not a
 * greyed-out one, and not one that opens an apology. A control the product
 * cannot honour is worse than an absent control, because the user spends a tap
 * finding out.
 *
 * UC-2.3 (#163) supplies the real implementation. Everything here is written
 * against the interface, so that lands as an injected service rather than as a
 * rewrite of this file.
 *
 * ── A transcript is never submitted ──────────────────────────────
 *
 * `onFinal` puts the words in the text field and stops. A recogniser that
 * misheard a time would otherwise create a commitment nobody said — the same
 * failure #162 spent its length removing from the extractor. The user reads it
 * and presses Analyze themselves.
 */
export function VoiceButton({
  service = noopSpeechCaptureService,
  autoFocus = false,
  onPartial,
  onFinal,
}: {
  service?: SpeechCaptureService;
  /** `input=voice` arrived on the link, so start listening without a tap. */
  autoFocus?: boolean;
  onPartial(transcript: string): void;
  onFinal(transcript: string): void;
}) {
  const { t, p } = useApp();
  const [status, setStatus] = useState<SpeechStatus>(service.status);
  const started = useRef(false);
  // The callers are rebuilt every render; the recogniser is started once and
  // keeps whatever it was handed. A ref written in an effect rather than during
  // render, which the React Compiler rules refuse.
  const latest = useRef({ onPartial, onFinal });
  useEffect(() => { latest.current = { onPartial, onFinal }; }, [onPartial, onFinal]);

  const begin = React.useCallback(() => {
    void service.start({
      onPartial: (text) => latest.current.onPartial(text),
      onFinal: (text) => latest.current.onFinal(text),
      onStatus: setStatus,
    });
  }, [service]);

  // `input=voice` from a widget or share link. Once: re-firing would restart
  // the recogniser under someone mid-sentence.
  useEffect(() => {
    if (!autoFocus || started.current) return;
    if (service.status === 'unavailable') return;
    started.current = true;
    begin();
  }, [autoFocus, begin, service.status]);

  // No recogniser on this device, or the feature is not built yet.
  if (status === 'unavailable') return null;

  if (status === 'permissionDenied') {
    return (
      <Txt size={12} color={p.mu} testID="voice-denied">{t.privacyVoice}</Txt>
    );
  }

  const listening = status === 'listening';

  return (
    <View style={{ alignItems: 'center', gap: 8 }}>
      {listening ? <Waveform color={p.ac} /> : null}
      <Btn
        testID="voice-button"
        label={listening ? t.stopReview : t.tapToTalk}
        onPress={() => (listening ? void service.stop() : begin())}
        style={{
          width: 56, height: 56, borderRadius: 28,
          backgroundColor: listening ? p.ac : p.sf,
          borderWidth: listening ? 0 : 1, borderColor: p.ln,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <MicIcon size={22} color={listening ? p.onAccent : p.ac} />
      </Btn>
    </View>
  );
}
