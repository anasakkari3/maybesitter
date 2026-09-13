import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useCaptureFlow } from '../features/capture/CaptureProvider';
import { MAX_CAPTURE_LENGTH, hasUnsavedText } from '../features/capture/captureMachine';
import { noCommitmentLine } from '../features/capture/noCommitment';
import { EXAMPLE_KEYS, exampleText } from '../features/capture/examples';
import { fill } from '../i18n/strings';
import { family } from '../theme/fonts';
import { cardShadow } from '../theme/tokens';
import { VoiceButton } from '../features/capture/voice/VoiceButton';
import { createSpeechCaptureService, SpeechEventBridge } from '../features/capture/voice/speechService';
import { speechLanguageForTag } from '../features/capture/voice/speechLocale';
import { Btn, FlowHeader, Pill, Txt } from '../ui/primitives';
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
 */
export function CaptureScreen() {
  const { t, p, ar, lang, actions } = useApp();
  const flow = useCaptureFlow();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // One per mount of the composer. Rebuilding it on every render would drop the
  // recogniser's listeners under somebody mid-sentence.
  const [speech] = useState(() => createSpeechCaptureService(() => speechLanguageForTag(lang)));
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

  const tooLong = state.text.length > MAX_CAPTURE_LENGTH;
  const canAnalyze = state.text.trim().length > 0 && !tooLong && state.status !== 'analyzing';

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      {/* Renders nothing; it gives the recogniser's hooks a component to live
          in so the service can stay a plain object (UC-2.3, #163). */}
      <SpeechEventBridge />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlowHeader pill={t.cancel} onPill={requestClose} title={t.captureTitle} />
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, paddingTop: 20, paddingHorizontal: 20, paddingBottom: 34, gap: 16 }}
        >
          {confirmingDiscard ? (
            <View style={{ flex: 1, justifyContent: 'center', gap: 14 }} testID="capture-discard">
              <Txt size={22} weight={600}>{t.captureDiscardTitle}</Txt>
              <Txt size={15} color={p.mu} lh={1.5}>{t.captureDiscardBody}</Txt>
              <Pill testID="capture-discard-keep" label={t.captureKeepEditing} onPress={() => setConfirmingDiscard(false)} />
              <Pill testID="capture-discard-confirm" label={t.captureDiscardConfirm} onPress={leave} kind="warm" />
            </View>
          ) : state.status === 'analyzing' ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22 }} testID="capture-analyzing">
              <ProcessingDots color={p.ac} />
              <Txt size={18} weight={500} align="center">{t.understanding}</Txt>
              <Txt size={14} color={p.mu} align="center" style={{ maxWidth: 260 }}>{state.text}</Txt>
            </View>
          ) : state.status === 'noCommitment' ? (
            <NothingFound line={noCommitmentLine(state.proposal?.noCommitmentReason, strings)} onClose={leave} />
          ) : state.status === 'networkError' || state.status === 'validationError' || state.status === 'extractionFailed' ? (
            <Failed status={state.status} onRetry={() => void flow.analyze()} onBack={() => flow.backToComposer()} />
          ) : (
            <>
              <View style={{ flex: 1, gap: 12 }}>
                {/* The AI chip is display only. Analyze works either way — the
                    server picks rules and makes no model call — so this says
                    what will happen, it does not gate anything (#161). */}
                {!flow.aiGranted ? (
                  <Btn
                    testID="capture-ai-off"
                    label={t.captureAiOff}
                    onPress={() => actions.go('trust')}
                    style={{ alignSelf: 'flex-start', backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12, gap: 2 }}
                  >
                    <Txt size={12} weight={600}>{t.captureAiOff}</Txt>
                    <Txt size={11} color={p.mu}>{t.captureAiOffHint}</Txt>
                  </Btn>
                ) : null}

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
                      minHeight: 150, backgroundColor: p.sf, borderWidth: 1,
                      borderColor: tooLong ? p.wm : p.ln, borderRadius: 24, padding: 18,
                      fontSize: 20, lineHeight: 30, color: p.tx, fontFamily: family(400, ar),
                      textAlign: ar ? 'right' : 'left', writingDirection: ar ? 'rtl' : 'ltr',
                    },
                    cardShadow(p),
                  ]}
                />

                {/* Shown only as the limit gets close: a counter on an empty
                    field is a rule nobody asked about yet. */}
                {state.text.length > MAX_CAPTURE_LENGTH - 200 ? (
                  <Txt size={12} color={tooLong ? p.wm : p.mu} testID="capture-counter">
                    {fill(t.captureCounter, { n: String(state.text.length) })}
                  </Txt>
                ) : null}

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {EXAMPLE_KEYS.map((key) => (
                    <Btn
                      key={key}
                      testID={`capture-example-${key}`}
                      label={exampleText(key, t)}
                      onPress={() => flow.setText(exampleText(key, t))}
                      style={{ backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12 }}
                    >
                      <Txt size={12}>{exampleText(key, t)}</Txt>
                    </Btn>
                  ))}
                </View>
              </View>

              <Txt size={12} color={p.mu} align="center">{t.privacyText}</Txt>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                {/* Renders nothing until a recogniser exists (UC-2.3 #163).
                    A transcript lands in the field and is never submitted for
                    the user. */}
                <VoiceButton
                  service={speech}
                  autoFocus={state.inputMode === 'voice'}
                  onPartial={flow.setText}
                  onFinal={flow.setText}
                />
                <Pill
                  testID="capture-analyze"
                  label={t.analyze}
                  onPress={() => void flow.analyze()}
                  disabled={!canAnalyze}
                  style={{ flex: 1 }}
                />
              </View>
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
 * The three ways analyze can fail, told apart.
 *
 * A 400 is the server refusing this input and it will refuse it again, so there
 * is no Retry — offering one would invite the user to press it until they gave
 * up. Network and extraction both get one, because both can succeed next time.
 */
function Failed({
  status, onRetry, onBack,
}: {
  status: 'networkError' | 'validationError' | 'extractionFailed';
  onRetry: () => void;
  onBack: () => void;
}) {
  const { t, p } = useApp();
  const message = status === 'networkError'
    ? t.errorsNetwork
    : status === 'validationError'
      ? t.errorsValidation
      : t.errorsGeneric;

  return (
    <>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 12 }} testID={`capture-error-${status}`}>
        <Txt size={20} weight={600} align="center">{t.captureFailedTitle}</Txt>
        <Txt size={14} color={p.mu} align="center">{message}</Txt>
      </View>
      <View style={{ gap: 10 }}>
        {status === 'validationError' ? null : (
          <Pill testID="capture-retry" label={t.errorsRetry} onPress={onRetry} />
        )}
        <Pill testID="capture-error-back" label={t.back} onPress={onBack} kind="outline" />
      </View>
    </>
  );
}
