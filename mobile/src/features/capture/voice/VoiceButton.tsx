import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Linking, View } from 'react-native';
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
 * ── It says what happened ────────────────────────────────────────
 *
 * While listening the mic is a Stop control (a square, named "Stop and
 * check"): dictation runs until the user taps it, however long they pause.
 * A failed attempt or a quiet room keeps the mic and adds one short line; a
 * refused microphone adds a line and a way to Settings. Only a device with no
 * recogniser, or none for this language, hides the mic.
 *
 * `onFinal` puts the words in the text field and stops. A recogniser that
 * misheard a time would otherwise create a commitment nobody said — the same
 * failure #162 spent its length removing from the extractor. The user reads it
 * and presses Analyze themselves.
 */
export function VoiceButton({
  service = noopSpeechCaptureService,
  autoFocus = false,
  variant = 'round',
  label,
  testID = 'voice-button',
  showNote = true,
  onStart,
  onStatusChange,
  onPartial,
  onFinal,
}: {
  service?: SpeechCaptureService;
  /**
   * `round` is the composer's mic. `pill` is a labelled, full-width primary
   * action for a screen where speaking is the main way to answer — the first
   * onboarding question. Same recogniser, same rules; only the shape differs.
   */
  variant?: 'round' | 'pill';
  /** The pill's words while idle. Listening always reads "Stop and check". */
  label?: string;
  testID?: string;
  /** `input=voice` arrived on the link, so start listening without a tap. */
  autoFocus?: boolean;
  /**
   * Whether the status line (`VoiceNote`) renders under the button. The
   * composer turns it off and renders it itself, full width above its footer
   * row, from `onStatusChange`.
   */
  showNote?: boolean;
  /** A dictation is starting: the caller notes what the field held before it. */
  onStart?(): void;
  onStatusChange?(status: SpeechStatus): void;
  onPartial(transcript: string): void;
  onFinal(transcript: string): void;
}) {
  const { t, p } = useApp();
  // The status belongs to the recogniser it came from. A new one (the language
  // chip) starts from its own status, so a failure in the last language does
  // not hide or annotate the mic for the next.
  const [reported, setReported] = useState<{ from: SpeechCaptureService; status: SpeechStatus }>(
    { from: service, status: service.status },
  );
  const status = reported.from === service ? reported.status : service.status;
  const started = useRef(false);
  // A start in flight. Presses during it are ignored: a second start used to
  // detach the first session's listeners while its recogniser kept running.
  const starting = useRef(false);
  // The callers are rebuilt every render; the recogniser is started once and
  // keeps whatever it was handed. A ref written in an effect rather than during
  // render, which the React Compiler rules refuse.
  const latest = useRef({ onPartial, onFinal, onStart, onStatusChange });
  useEffect(() => {
    latest.current = { onPartial, onFinal, onStart, onStatusChange };
  }, [onPartial, onFinal, onStart, onStatusChange]);

  useEffect(() => { latest.current.onStatusChange?.(status); }, [status]);

  // Leaving the screen (or switching language) mid-sentence releases the
  // microphone, and nothing heard afterwards is written anywhere.
  useEffect(() => () => {
    starting.current = false;
    void service.cancel?.();
  }, [service]);

  const begin = React.useCallback(() => {
    if (starting.current) return;
    starting.current = true;
    latest.current.onStart?.();
    void service
      .start({
        onPartial: (text) => latest.current.onPartial(text),
        onFinal: (text) => latest.current.onFinal(text),
        onStatus: (next) => setReported({ from: service, status: next }),
      })
      .finally(() => { starting.current = false; });
  }, [service]);

  // `input=voice` from a widget or share link. Once: re-firing would restart
  // the recogniser under someone mid-sentence.
  useEffect(() => {
    if (!autoFocus || started.current) return;
    if (service.status === 'unavailable') return;
    started.current = true;
    begin();
  }, [autoFocus, begin, service.status]);

  const listening = status === 'listening';
  const press = () => {
    if (listening) void service.stop();
    else if (status !== 'requestingPermission') begin();
  };
  const note = showNote ? <VoiceNote status={status} /> : null;

  // No recogniser on this device, or none for this language: no button. The
  // note still says why, so the language chip beside it has a reason to exist.
  if (status === 'unavailable' || status === 'localeUnavailable') return note;

  const a11yState = { busy: status === 'requestingPermission' };

  if (variant === 'pill') {
    const words = listening ? t.stopReview : (label ?? t.tapToTalk);
    return (
      <View style={{ gap: 10, alignItems: 'stretch' }}>
        <Btn
          testID={testID}
          label={words}
          onPress={press}
          accessibilityState={a11yState}
          scaleTo={0.98}
          style={{
            minHeight: 54,
            borderRadius: 999,
            paddingHorizontal: 20,
            backgroundColor: p.ac,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          {listening ? <StopGlyph color={p.onAccent} /> : <MicIcon size={20} color={p.onAccent} />}
          <Txt size={16} weight={600} color={p.onAccent}>{words}</Txt>
        </Btn>
        {listening ? <View style={{ alignItems: 'center' }}><Waveform color={p.ac} /></View> : null}
        {note}
      </View>
    );
  }

  const button = (
    <Btn
      testID={testID}
      label={listening ? t.stopReview : t.tapToTalk}
      onPress={press}
      accessibilityState={a11yState}
      style={{
        width: 56, height: 56, borderRadius: 28,
        backgroundColor: listening ? p.ac : p.sf,
        borderWidth: listening ? 0 : 1, borderColor: p.ln,
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      {listening ? <StopGlyph color={p.onAccent} /> : <MicIcon size={22} color={p.ac} />}
    </Btn>
  );
  if (!note) return button;
  return (
    <View style={{ alignItems: 'center', gap: 8 }}>
      {button}
      {note}
    </View>
  );
}

/** A filled square: the platform-wide sign for "stop recording". */
function StopGlyph({ color }: { color: string }) {
  return (
    <View
      testID="voice-stop-glyph"
      style={{ width: 18, height: 18, borderRadius: 4, backgroundColor: color }}
    />
  );
}

/**
 * The one short line under the mic, for the states that need words.
 *
 * Idle says nothing. Listening says how to finish. A failed attempt and a quiet
 * room say to try again; the mic stays. A refused microphone says so and offers
 * the only place that can change it. Announced to screen readers, since each
 * appears without the user touching it.
 */
export function VoiceNote({ status }: { status: SpeechStatus }) {
  const { t, p } = useApp();
  const line = noteFor(status, t);
  useEffect(() => {
    if (line && status !== 'listening') AccessibilityInfo.announceForAccessibility(line);
  }, [line, status]);
  if (!line) return null;

  if (status === 'permissionDenied') {
    return (
      <View style={{ gap: 4, alignItems: 'flex-start' }} accessibilityLiveRegion="polite">
        <Txt size={13} color={p.mu} testID="voice-denied">{line}</Txt>
        <Btn
          testID="voice-open-settings"
          label={t.notifOpenSettings}
          onPress={() => { void Linking.openSettings(); }}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Txt size={14} weight={600} color={p.tx} style={{ textDecorationLine: 'underline' }}>
            {t.notifOpenSettings}
          </Txt>
        </Btn>
      </View>
    );
  }

  return (
    <View accessibilityLiveRegion="polite">
      <Txt size={13} color={p.mu} testID="voice-note">{line}</Txt>
    </View>
  );
}

function noteFor(status: SpeechStatus, t: ReturnType<typeof useApp>['t']): string | null {
  switch (status) {
    case 'listening': return t.voiceListening;
    case 'failed': return t.voiceFailed;
    case 'noSpeech': return t.voiceNoSpeech;
    case 'permissionDenied': return t.voiceDenied;
    case 'localeUnavailable': return t.voiceLocaleUnavailable;
    default: return null;
  }
}
