import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useCaptureFlow } from '../features/capture/CaptureProvider';
import { MAX_CAPTURE_LENGTH, wantsDiscardConfirmation } from '../features/capture/captureMachine';
import { noCommitmentLine } from '../features/capture/noCommitment';
import { COMPOSER_EXAMPLE_KEYS, exampleText } from '../features/capture/examples';
import { ClipboardImportSheet } from '../features/capture/ClipboardImportSheet';
import { readClipboardText, type ClipboardImport } from '../features/capture/clipboardImport';
import { fill } from '../i18n/strings';
import { family, LINE_HEIGHT } from '../theme/fonts';
import { useLayoutMode } from '../theme/textScale';
import { VoiceButton, VoiceNote } from '../features/capture/voice/VoiceButton';
import { appendDictation } from '../features/capture/voice/dictationText';
import type { SpeechStatus } from '../features/capture/voice/SpeechCaptureService';
import { createSpeechCaptureService, SpeechEventBridge } from '../features/capture/voice/speechService';
import { VoiceLanguageChip } from '../features/capture/voice/VoiceLanguageChip';
import { speechLanguageForTag } from '../features/capture/voice/speechLocale';
import {
  loadSpeechLanguage,
  saveSpeechLanguage,
  type SpeechLanguagePref,
} from '../lib/deviceSettings/speechLanguage';
import { Btn, Pill, Txt } from '../ui/primitives';
import { TaskHeader } from '../ui/taskHeader';
import type { UserFacingKey } from '../api/ui/userFacingMessage';
import { ProcessingDots, ScreenIn } from '../ui/motion';
import { AvoidKeyboard } from '../ui/keyboard';

/**
 * The composer (UC-2.R2, #172).
 *
 * ── It talks to the server now ───────────────────────────────────
 *
 * This screen used to run `analyzeText` from `src/services/mockCapture.ts`
 * against the design's sample sentences, and write its results into
 * `AppContext`. `CaptureProvider`, the reducer and the gateway had all been
 * built and tested — and nothing outside `src/features/capture/` imported any
 * of them, so no user could reach a single line of it. This is that wiring.
 *
 * The example chips survive as copy. `src/services/mockCapture.ts` is gone
 * entirely: tapping one now types its text into the real field, and the real
 * endpoint reads it like any other sentence.
 *
 * ── Closing forgets what was typed ───────────────────────────────
 *
 * The draft is the most sensitive text the product handles — whatever somebody
 * was about to commit to, before deciding whether to. It lives only in the
 * flow's reducer, and Close resets it. With text in the field, Close asks
 * first, because a mis-tap should not be able to destroy it silently.
 *
 * ── Pasting is one more way to type, not a second flow ───────────
 *
 * The Paste button reads the clipboard once, on that press, and shows what it
 * found (`ClipboardImportSheet`). Agreeing puts the text through `flow.setText`
 * — the reducer's `textChanged`, the same event every keystroke dispatches — so
 * a pasted capture is in the identical composer state a typed one is in, and
 * goes through the same analyze → review → confirm machine. Nothing about it
 * reaches the server any sooner than typed text does.
 *
 * ── Dictation adds, it does not replace ──────────────────────────
 *
 * Each dictation appends to what the field held when it started; its partials
 * replace only its own words. Typing "A" and saying "B c" gives "A B c", and
 * a second dictation appends again.
 *
 * ── The keyboard never covers Analyze ────────────────────────────
 *
 * Analyze and the mic live in a footer outside the ScrollView, inside the
 * keyboard-avoiding container (`AvoidKeyboard`), so the keyboard pushes them
 * up instead of hiding them — measured in the window, so the email banner
 * above this screen cannot throw it off.
 * The field has a maxHeight and scrolls itself, so a long draft cannot push
 * its own caret under the keyboard. Hints and examples scroll.
 */
export function CaptureScreen() {
  const { t, p, rtl, script, lang, actions } = useApp();
  const flow = useCaptureFlow();
  const stacked = useLayoutMode() !== 'normal';
  const insets = useSafeAreaInsets();
  const keyboardShown = useKeyboardShown();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<SpeechStatus>('idle');
  /**
   * What the last deliberate clipboard read found, while it is being reviewed.
   *
   * Null except between pressing Paste and answering the sheet — and there is
   * no effect anywhere in this file that sets it. The clipboard is read on a
   * press and on nothing else: not on mount, not on focus, not when the app
   * comes back to the foreground. See `clipboardImport.ts`.
   */
  const [clipboard, setClipboard] = useState<ClipboardImport | null>(null);
  /**
   * Which language the mic listens for.
   *
   * Defaults to the app's, then to whatever the person last dictated in — a
   * fact about this device, not about the account (see
   * `lib/deviceSettings/speechLanguage.ts`). Read in an effect so the first
   * render does not wait on storage.
   */
  const [speechLang, setSpeechLang] = useState<SpeechLanguagePref>(() => speechLanguageForTag(lang));
  useEffect(() => {
    let active = true;
    void loadSpeechLanguage().then((stored) => { if (active && stored) setSpeechLang(stored); });
    return () => { active = false; };
  }, []);

  /*
   * Rebuilt only when the chosen language changes.
   *
   * Not per render — that would drop the recogniser's listeners under somebody
   * mid-sentence. Not once per mount either: switching language mid-session
   * should start a fresh session in the new one, which is exactly what tapping
   * the chip is asking for.
   */
  const speech = useMemo(() => createSpeechCaptureService(() => speechLang), [speechLang]);
  const strings = t as unknown as Record<string, string>;
  const { state } = flow;

  // What the field held when this dictation started. Refs written in effects
  // and handlers, never during render.
  const latestText = useRef(state.text);
  useEffect(() => { latestText.current = state.text; }, [state.text]);
  const dictationBase = useRef('');
  const onDictationStart = () => { dictationBase.current = latestText.current; };
  const onDictated = (spoken: string) => flow.setText(appendDictation(dictationBase.current, spoken));

  const leave = () => {
    flow.close();
    setConfirmingDiscard(false);
    actions.closeCapture();
  };

  const requestClose = () => {
    if (wantsDiscardConfirmation(state)) setConfirmingDiscard(true);
    else leave();
  };

  /** The only clipboard read in the app's capture flow, and it needs a tap. */
  const pasteFromClipboard = async () => setClipboard(await readClipboardText());

  const tooLong = state.text.length > MAX_CAPTURE_LENGTH;
  const canAnalyze = state.text.trim().length > 0 && !tooLong && state.status !== 'analyzing';
  const failed = isFailedStatus(state.status) ? state.status : null;
  const composing = !confirmingDiscard && !clipboard && failed === null
    && state.status !== 'analyzing' && state.status !== 'noCommitment';

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      {/* Renders nothing; it gives the recogniser's hooks a component to live
          in so the service can stay a plain object (UC-2.3, #163). */}
      <SpeechEventBridge />
      <AvoidKeyboard testID="capture-kav" style={{ flex: 1 }}>
        <TaskHeader
          pill={t.cancel}
          onPill={requestClose}
          title={t.captureTitle}
          end={
            // The AI chip is display only. Analyze works either way — the
            // server picks rules and makes no model call — so this says what
            // will happen, it does not gate anything (#161). Round 2 puts it
            // in the header's end slot, where a status belongs.
            !flow.aiGranted ? (
              <Btn
                testID="capture-ai-off"
                label={`${t.captureAiOff}. ${t.captureAiOffHint}`}
                onPress={() => actions.go('trust')}
                hitSlop={8}
                style={{ backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 10, minHeight: 32, justifyContent: 'center' }}
              >
                <Txt size={12} color={p.mu}>{t.captureAiOff}</Txt>
              </Btn>
            ) : null
          }
        />
        <ScrollView
          testID="capture-scroll"
          keyboardShouldPersistTaps="handled"
          // The footer owns the bottom inset while composing.
          contentContainerStyle={{ flexGrow: 1, paddingTop: 16, paddingHorizontal: 16, paddingBottom: composing ? 16 : 34, gap: 14 }}
        >
          {confirmingDiscard ? (
            <View style={{ flex: 1, justifyContent: 'center', gap: 14 }} testID="capture-discard">
              <Txt size={22} weight={600}>{t.captureDiscardTitle}</Txt>
              <Txt size={15} color={p.mu} lh={1.5}>{t.captureDiscardBody}</Txt>
              <Pill testID="capture-discard-keep" label={t.captureKeepEditing} onPress={() => setConfirmingDiscard(false)} />
              <Pill testID="capture-discard-confirm" label={t.captureDiscardConfirm} onPress={leave} kind="warm" />
            </View>
          ) : clipboard ? (
            <ClipboardImportSheet
              result={clipboard}
              replacing={state.text.trim().length > 0}
              // `setText` is the composer's own sink — `textChanged` in the
              // reducer. Pasted text is in the same state typed text is in the
              // instant this returns, and nothing else here touches it.
              onUse={(text) => { flow.setText(text); setClipboard(null); }}
              onCancel={() => setClipboard(null)}
            />
          ) : state.status === 'analyzing' ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22 }} testID="capture-analyzing">
              <ProcessingDots color={p.ac} />
              <Txt size={18} weight={500} align="center">{t.understanding}</Txt>
              <Txt size={14} color={p.mu} align="center" style={{ maxWidth: 260 }}>{state.text}</Txt>
            </View>
          ) : state.status === 'noCommitment' ? (
            <NothingFound line={noCommitmentLine(state.proposal?.noCommitmentReason, strings)} onClose={leave} />
          ) : failed !== null ? (
              <Failed
                status={failed}
                messageKey={state.messageKey}
                onRetry={() => void flow.analyze()}
                onBack={() => flow.backToComposer()}
              />
          ) : (
            <View style={{ flex: 1, gap: 16 }}>
              <Txt role="section" style={{ paddingHorizontal: 4 }}>{t.sayItLikeYouThink}</Txt>
              <View>
                <TextInput
                  testID="capture-input"
                  value={state.text}
                  onChangeText={flow.setText}
                  placeholder={t.typePlaceholder}
                  placeholderTextColor={p.mu}
                  autoFocus
                  multiline
                  // Capped, and scrolls itself: a long draft keeps its caret
                  // in view instead of growing under the keyboard.
                  scrollEnabled
                  textAlignVertical="top"
                  accessibilityLabel={t.sayItLikeYouThink}
                  style={[
                    {
                      minHeight: 140, maxHeight: stacked ? 260 : 220, backgroundColor: p.sf, borderWidth: 1,
                      borderColor: tooLong ? p.wm : p.lnStrong, borderRadius: 24,
                      paddingTop: 18, paddingHorizontal: 18, paddingBottom: 34,
                      fontSize: 20, lineHeight: Math.round(20 * LINE_HEIGHT[script]), color: p.tx, fontFamily: family(400, script),
                      textAlign: rtl ? 'right' : 'left', writingDirection: rtl ? 'rtl' : 'ltr',
                    },
                  ]}
                />
                {/* Inside the field's bottom corner (Round 2), and only as
                    the limit gets close: a counter on an empty field is a
                    rule nobody asked about yet. */}
                {state.text.length > MAX_CAPTURE_LENGTH - 200 ? (
                  <Txt size={11} color={tooLong ? p.wm : p.mu} latin testID="capture-counter" style={{ position: 'absolute', bottom: 12, end: 18 }}>
                    {fill(t.captureCounter, { n: String(state.text.length) })}
                  </Txt>
                ) : null}
              </View>

              {/* Paste reads the clipboard here and only here, on that press,
                  and fills the field and nothing more. */}
              <Btn
                testID="capture-paste"
                label={t.capturePaste}
                onPress={() => { void pasteFromClipboard(); }}
                style={{ minHeight: 48, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 16, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' }}
              >
                <Txt role="supporting" weight={600}>{t.capturePaste}</Txt>
              </Btn>

              {/* One hint line and three examples. The share hint, two more
                  chips and a chip repeating the placeholder used to stack up
                  here and push the field under the keyboard. */}
              {state.text.length === 0 ? <View style={{ gap: 8 }}>
                <Txt size={12} color={p.mu} style={{ paddingHorizontal: 4 }}>{t.tryOne}</Txt>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {COMPOSER_EXAMPLE_KEYS.map((key) => (
                    <Btn
                      key={key}
                      testID={`capture-example-${key}`}
                      label={exampleText(key, t)}
                      onPress={() => flow.setText(exampleText(key, t))}
                      style={{ borderWidth: 1, borderColor: p.ln, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, minHeight: 44, justifyContent: 'center', ...(stacked ? { width: '100%' } : {}) }}
                    >
                      <Txt role="supporting" color={p.mu}>{exampleText(key, t)}</Txt>
                    </Btn>
                  ))}
                </View>
              </View> : null}

              <Txt size={12} color={p.mu} align="center" lh={1.5}>{t.privacyText}</Txt>
            </View>
          )}
        </ScrollView>

        {composing ? (
          // Pinned above the keyboard: AvoidKeyboard lifts this,
          // the ScrollView above it shrinks.
          <View
            testID="capture-footer"
            style={{
              paddingHorizontal: 16, paddingTop: 10,
              // The home indicator matters only while the keyboard is down.
              paddingBottom: keyboardShown ? 10 : Math.max(insets.bottom, 12),
              gap: 8, backgroundColor: p.bg,
              borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.ln,
            }}
          >
            <VoiceNote status={voiceStatus} />
            <View style={stacked
              ? { gap: 10, alignItems: 'stretch' }
              : { flexDirection: 'row', alignItems: 'center', gap: 10 }}
            >
              {/* The mic and which language it listens for. Each fills the
                  field and nothing more. */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <VoiceButton
                  service={speech}
                  showNote={false}
                  autoFocus={state.inputMode === 'voice'}
                  onStart={onDictationStart}
                  onStatusChange={setVoiceStatus}
                  onPartial={onDictated}
                  onFinal={onDictated}
                />
                {/* A language chooser beside a mic this device cannot offer is a
                    setting for nothing. */}
                {voiceStatus !== 'unavailable' ? (
                  <VoiceLanguageChip
                    value={speechLang}
                    onChange={(next) => { setSpeechLang(next); void saveSpeechLanguage(next); }}
                  />
                ) : null}
              </View>
              <Pill
                testID="capture-analyze"
                label={t.analyze}
                // The field unmounts as analyzing starts; let go of it while
                // it is still on screen, or its blur has nowhere to land (D4).
                onPress={() => { Keyboard.dismiss(); void flow.analyze(); }}
                disabled={!canAnalyze}
                size={17}
                pad={14}
                style={stacked ? undefined : { flex: 1 }}
              />
            </View>
          </View>
        ) : null}
      </AvoidKeyboard>
    </ScreenIn>
  );
}

/** Whether the software keyboard is up, so the footer can drop the home-indicator inset. */
function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setShown(true));
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setShown(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return shown;
}

type FailedStatus = 'networkError' | 'validationError' | 'extractionFailed' | 'refused';

function isFailedStatus(status: string): status is FailedStatus {
  return status === 'networkError' || status === 'validationError'
    || status === 'extractionFailed' || status === 'refused';
}

/**
 * Nothing was created, and the screen says only that (UC-2.6, #166).
 *
 * The line comes from the server's reason code through a fixed lookup. What is
 * deliberately absent is any reaction to the message itself: the text the user
 * wrote is not echoed back here, because quoting «حسّيت بضغط» under a heading
 * is a response to the person rather than to their request.
 */
function NothingFound({ line, onClose }: { line: string; onClose: () => void }) {
  const { t, p } = useApp();
  const flow = useCaptureFlow();
  return (
    <>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 12 }} testID="capture-nothing">
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: p.sf2 }} />
        <Txt size={20} weight={600} align="center">{t.nothingTitle}</Txt>
        <Txt size={14} color={p.mu} align="center" testID="capture-nothing-reason">{line}</Txt>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Pill testID="capture-nothing-close" label={t.close} onPress={onClose} kind="soft" size={15} weight={500} style={{ flex: 1 }} />
        <Pill testID="capture-nothing-rephrase" label={t.rephrase} onPress={() => flow.backToComposer()} size={15} style={{ flex: 1 }} />
      </View>
    </>
  );
}

/**
 * The four ways analyze can fail, told apart.
 *
 * ── The words are not chosen here ────────────────────────────────
 *
 * `messageKey` comes from `userFacingMessageKey`, the one table that turns an
 * error into copy. This screen used to pick between three strings itself, and
 * the AI refusals — a spent daily quota, a minute's rate limit, a busy
 * service, text too long — had localized lines in en/ar/he that no branch
 * could reach: all four came out as "something went wrong" (#181). A screen
 * that writes its own copy is a second table, and a second table drifts.
 *
 * ── Which failures get a Retry ───────────────────────────────────
 *
 * A 400 is the server refusing this input and it will refuse it again, so
 * there is no Retry — offering one would invite the user to press it until
 * they gave up. A refusal is the same answer for a different reason: pressing
 * Retry against a spent quota is precisely the loop the quota exists to stop.
 * Back is always there, and it returns to the composer with the text intact.
 */
function Failed({
  status, messageKey, onRetry, onBack,
}: {
  status: FailedStatus;
  messageKey: UserFacingKey | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  const { t, p } = useApp();
  // Read now, not when the failure happened: switching language with this on
  // screen has to change the sentence, which a stored message could not do.
  const message = messageKey ? t[messageKey] : t.errorsGeneric;
  const retryable = status === 'networkError' || status === 'extractionFailed';

  return (
    <>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 12 }} testID={`capture-error-${status}`}>
        <Txt size={20} weight={600} align="center">{t.captureFailedTitle}</Txt>
        <Txt size={14} color={p.mu} align="center" testID="capture-error-message">{message}</Txt>
      </View>
      <View style={{ gap: 10 }}>
        {retryable ? (
          <Pill testID="capture-retry" label={t.errorsRetry} onPress={onRetry} />
        ) : null}
        <Pill testID="capture-error-back" label={t.back} onPress={onBack} kind="outline" />
      </View>
    </>
  );
}
