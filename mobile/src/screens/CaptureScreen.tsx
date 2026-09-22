import React, { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useCaptureFlow } from '../features/capture/CaptureProvider';
import { MAX_CAPTURE_LENGTH, hasUnsavedText } from '../features/capture/captureMachine';
import { noCommitmentLine } from '../features/capture/noCommitment';
import { EXAMPLE_KEYS, exampleText } from '../features/capture/examples';
import { ClipboardImportSheet } from '../features/capture/ClipboardImportSheet';
import { readClipboardText, type ClipboardImport } from '../features/capture/clipboardImport';
import { fill } from '../i18n/strings';
import { family, LINE_HEIGHT } from '../theme/fonts';
import { useLayoutMode } from '../theme/textScale';
import { VoiceButton } from '../features/capture/voice/VoiceButton';
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
 */
export function CaptureScreen() {
  const { t, p, rtl, script, lang, actions } = useApp();
  const flow = useCaptureFlow();
  const stacked = useLayoutMode() !== 'normal';
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
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

  const leave = () => {
    flow.close();
    setConfirmingDiscard(false);
    actions.closeCapture();
  };

  const requestClose = () => {
    if (hasUnsavedText(state)) setConfirmingDiscard(true);
    else leave();
  };

  /** The only clipboard read in the app's capture flow, and it needs a tap. */
  const pasteFromClipboard = async () => setClipboard(await readClipboardText());

  const tooLong = state.text.length > MAX_CAPTURE_LENGTH;
  const canAnalyze = state.text.trim().length > 0 && !tooLong && state.status !== 'analyzing';

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      {/* Renders nothing; it gives the recogniser's hooks a component to live
          in so the service can stay a plain object (UC-2.3, #163). */}
      <SpeechEventBridge />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
                style={{ backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 10, minHeight: 32, justifyContent: 'center' }}
              >
                <Txt size={12} color={p.mu}>{t.captureAiOff}</Txt>
              </Btn>
            ) : null
          }
        />
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, paddingTop: 16, paddingHorizontal: 16, paddingBottom: 34, gap: 14 }}
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
          ) : state.status === 'networkError' || state.status === 'validationError'
            || state.status === 'extractionFailed' || state.status === 'refused' ? (
              <Failed
                status={state.status}
                messageKey={state.messageKey}
                onRetry={() => void flow.analyze()}
                onBack={() => flow.backToComposer()}
              />
          ) : (
            <>
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
                    textAlignVertical="top"
                    accessibilityLabel={t.sayItLikeYouThink}
                    style={[
                      {
                        minHeight: 160, backgroundColor: p.sf, borderWidth: 1,
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

                {/* The three ways in besides typing, as one row: speak, paste,
                    and which language the mic listens for. Each fills the
                    field and nothing more — the clipboard is read here and
                    only here, on that press. */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <VoiceButton
                    service={speech}
                    autoFocus={state.inputMode === 'voice'}
                    onPartial={flow.setText}
                    onFinal={flow.setText}
                  />
                  <Btn
                    testID="capture-paste"
                    label={t.capturePaste}
                    onPress={() => { void pasteFromClipboard(); }}
                    style={{ flexGrow: 1, minHeight: 48, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 16, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Txt role="supporting" weight={600}>{t.capturePaste}</Txt>
                  </Btn>
                  <VoiceLanguageChip
                    value={speechLang}
                    onChange={(next) => { setSpeechLang(next); void saveSpeechLanguage(next); }}
                  />
                </View>
                <Txt size={12} color={p.mu} style={{ paddingHorizontal: 4 }}>{t.captureShareHint}</Txt>

                {state.text.length === 0 ? <View style={{ gap: 8 }}>
                  <Txt size={12} color={p.mu} style={{ paddingHorizontal: 4 }}>{t.tryOne}</Txt>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {EXAMPLE_KEYS.map((key) => (
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
              </View>

              <Txt size={12} color={p.mu} align="center" lh={1.5}>{t.privacyText}</Txt>
              <Pill
                testID="capture-analyze"
                label={t.analyze}
                onPress={() => void flow.analyze()}
                disabled={!canAnalyze}
                size={17}
                pad={14}
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenIn>
  );
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
  status: 'networkError' | 'validationError' | 'extractionFailed' | 'refused';
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
