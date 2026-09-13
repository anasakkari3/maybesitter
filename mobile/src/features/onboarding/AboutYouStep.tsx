import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Card, Txt } from '../../ui/primitives';
import { OnboardingChrome } from './OnboardingChrome';
import { MAX_DESCRIPTION_LENGTH } from './aboutYou';

/**
 * "What's your week like?" (UC-2.7b, #168).
 *
 * ── Skip is always visible ───────────────────────────────────────
 *
 * This is the one screen that asks somebody to write about themselves in their
 * own words, which is the most personal thing the product ever requests. A
 * Skip that appears only after a pause, or sits below the fold, is the pattern
 * that makes people type something to get past it. It is in the footer from
 * the first frame.
 *
 * ── With AI off, the text is never typed at all ──────────────────
 *
 * Not "typed and not sent" — the field is not there. Reading free text is the
 * whole mechanism, and it needs a model; with the model refused there is
 * nothing this screen can do with a paragraph, so it offers the thing that
 * does work instead. Anything the user wants remembered goes in by hand
 * through the memory screen, which stores it without a model.
 */
export function AboutYouStep({
  aiGranted,
  onDescribe,
  onManual,
  onSkip,
  onBack,
  reading = false,
  failed = false,
}: {
  aiGranted: boolean;
  onDescribe: (text: string) => void;
  onManual: () => void;
  onSkip: () => void;
  onBack: () => void;
  reading?: boolean;
  failed?: boolean;
}) {
  const { t, p, rtl } = useApp();
  const [text, setText] = useState('');
  const trimmed = text.trim();

  if (!aiGranted) {
    return (
      <OnboardingChrome
        step="about"
        title={t.obAboutManualTitle}
        testID="onboarding-about-manual"
        primary={{ label: t.obContinue, onPress: onManual }}
        secondary={{ label: t.obBack, onPress: onBack }}
      >
        <Card pad={18}>
          <Txt size={15} color={p.mu} lh={1.5}>{t.obAboutManualBody}</Txt>
        </Card>
      </OnboardingChrome>
    );
  }

  return (
    <OnboardingChrome
      step="about"
      title={t.obAboutTitle}
      testID="onboarding-about"
      primary={{
        label: reading ? t.obAboutReading : t.obAboutRead,
        onPress: () => onDescribe(trimmed),
        disabled: trimmed === '' || reading,
      }}
      secondary={{ label: t.obSkip, onPress: onSkip }}
      footNote={failed ? t.obAboutFailed : undefined}
    >
      <Card pad={18}>
        <TextInput
          testID="about-you-input"
          accessibilityLabel={t.obAboutTitle}
          value={text}
          onChangeText={setText}
          placeholder={t.obAboutPlaceholder}
          placeholderTextColor={p.mu}
          maxLength={MAX_DESCRIPTION_LENGTH}
          multiline
          editable={!reading}
          style={{
            color: p.tx,
            fontSize: 15,
            minHeight: 140,
            textAlignVertical: 'top',
            textAlign: rtl ? 'right' : 'left',
          }}
        />
      </Card>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
        <Txt size={12} color={p.mu} latin testID="about-you-count">
          {`${Array.from(trimmed).length} / ${MAX_DESCRIPTION_LENGTH}`}
        </Txt>
      </View>
    </OnboardingChrome>
  );
}

/** Re-exported so the flow does not import the constant from two places. */
export { MAX_DESCRIPTION_LENGTH };
