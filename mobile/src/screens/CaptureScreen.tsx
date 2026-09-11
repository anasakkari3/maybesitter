import React from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { exampleKeys, exampleText } from '../services/mockCapture';
import { family } from '../theme/fonts';
import { accentGlow, cardShadow } from '../theme/tokens';
import { Btn, FlowHeader, Pill, Txt } from '../ui/primitives';
import { MicIcon } from '../ui/icons';
import { Breathe, ProcessingDots, Rings, ScreenIn, Waveform } from '../ui/motion';

function Examples({ small }: { small?: boolean }) {
  const { t, p, actions } = useApp();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {exampleKeys.map(k => (
        <Btn key={k} onPress={() => actions.useExample(k)} style={{ backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 999, paddingVertical: small ? 8 : 9, paddingHorizontal: small ? 12 : 14 }}>
          <Txt size={small ? 12 : 13}>{exampleText(k, t)}</Txt>
        </Btn>
      ))}
    </View>
  );
}

function Field({ placeholder, autoFocus }: { placeholder?: string; autoFocus?: boolean }) {
  const { s, p, ar, actions } = useApp();
  return (
    <TextInput
      value={s.input}
      onChangeText={actions.setInput}
      placeholder={placeholder}
      placeholderTextColor={p.mu}
      autoFocus={autoFocus}
      multiline
      textAlignVertical="top"
      style={[
        {
          minHeight: 150, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 24, padding: 18,
          fontSize: 20, lineHeight: 30, color: p.tx, fontFamily: family(400, ar),
          textAlign: ar ? 'right' : 'left', writingDirection: ar ? 'rtl' : 'ltr',
        },
        cardShadow(p),
      ]}
    />
  );
}

export function CaptureScreen() {
  const { s, t, p, actions } = useApp();
  const liveTranscript = s.input.split(' ').slice(0, s.liveWords).join(' ');

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlowHeader pill={t.cancel} onPill={actions.closeCapture} title={t.captureTitle} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, paddingTop: 20, paddingHorizontal: 20, paddingBottom: 34, gap: 16 }}>
          {s.cap === 'idle' && (
            <>
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22 }}>
                <Txt size={24} weight={600} align="center" style={{ maxWidth: 280 }}>{t.sayItLikeYouThink}</Txt>
                <View style={{ width: 120, height: 120, alignItems: 'center', justifyContent: 'center' }}>
                  <Rings color={p.ac} size={96} />
                  <Breathe>
                    <Btn
                      onPressIn={actions.micDown}
                      onPressOut={actions.micUp}
                      label={t.tapToTalk}
                      style={[{ width: 96, height: 96, borderRadius: 48, backgroundColor: p.ac, alignItems: 'center', justifyContent: 'center' }, accentGlow(p)]}
                    >
                      <MicIcon size={34} color={p.onAccent} />
                    </Btn>
                  </Breathe>
                </View>
                <Txt size={13} color={p.mu} align="center">{t.tapToTalk}</Txt>
                <Btn onPress={actions.startTyping} style={{ padding: 10 }}>
                  <Txt size={15} weight={500} color={p.ac}>{t.orType}</Txt>
                </Btn>
              </View>
              <View style={{ gap: 8 }}>
                <Txt size={12} color={p.mu}>{t.tryOne}</Txt>
                <Examples />
              </View>
            </>
          )}

          {s.cap === 'listening' && (
            <>
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 26 }}>
                <Txt size={13} weight={600} color={p.ac} align="center">{t.listening}</Txt>
                <Waveform color={p.ac} />
                <Txt size={22} align="center" style={{ minHeight: 66, maxWidth: 300 }}>{liveTranscript}</Txt>
              </View>
              <Pill label={t.stopReview} onPress={actions.stopListening} kind="ink" />
            </>
          )}

          {s.cap === 'transcript' && (
            <>
              <View style={{ flex: 1, gap: 12 }}>
                <Txt size={13} color={p.mu}>{t.checkTranscript}</Txt>
                <Field />
                <View style={{ flexDirection: 'row' }}>
                  <Pill label={t.sayAgain} onPress={actions.startListening} kind="soft" size={13} weight={400} pad={10} />
                </View>
              </View>
              <Txt size={12} color={p.mu} align="center">{t.privacyVoice}</Txt>
              <Pill label={t.analyze} onPress={actions.analyze} />
            </>
          )}

          {s.cap === 'typing' && (
            <>
              <View style={{ flex: 1, gap: 12 }}>
                <Field placeholder={t.typePlaceholder} autoFocus />
                <Examples small />
              </View>
              <Txt size={12} color={p.mu} align="center">{t.privacyText}</Txt>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Btn onPress={actions.startListening} label={t.sayAgain} style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, alignItems: 'center', justifyContent: 'center' }}>
                  <MicIcon size={22} color={p.ac} />
                </Btn>
                <Pill label={t.analyze} onPress={actions.analyze} disabled={!s.input.trim()} style={{ flex: 1 }} />
              </View>
            </>
          )}

          {s.cap === 'processing' && (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22 }}>
              <ProcessingDots color={p.ac} />
              <Txt size={18} weight={500} align="center">{t.understanding}</Txt>
              <Txt size={14} color={p.mu} align="center" style={{ maxWidth: 260 }}>{s.input}</Txt>
            </View>
          )}

          {s.cap === 'nothing' && (
            <>
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 12 }}>
                <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: p.sf2 }} />
                <Txt size={20} weight={600} align="center">{t.nothingTitle}</Txt>
                <Txt size={14} color={p.mu} align="center">{t.nothingBody}</Txt>
                <View style={{ backgroundColor: p.sf, borderRadius: 16, paddingVertical: 10, paddingHorizontal: 14 }}>
                  <Txt size={14} align="center">{`“${s.input}”`}</Txt>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pill label={t.close} onPress={actions.closeCapture} kind="soft" size={15} weight={500} style={{ flex: 1 }} />
                <Pill label={t.rephrase} onPress={actions.startTyping} size={15} style={{ flex: 1 }} />
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenIn>
  );
}
