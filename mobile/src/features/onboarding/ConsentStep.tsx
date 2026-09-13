import React from 'react';
import { Switch, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Txt } from '../../ui/primitives';
import { OnboardingChrome } from './OnboardingChrome';

/**
 * The three questions, asked separately (UC-2.1 #161, UC-2.9 #170, UC-2.R1 #171).
 *
 * ── Nothing is pre-selected ──────────────────────────────────────
 *
 * The AI card has two buttons and no default. Not a switch defaulting to off —
 * a switch has a position before anybody touches it, and "off" would still be
 * a state the screen chose. Two equal buttons make the absence of an answer
 * visible, which is why Continue stays disabled until one is pressed.
 *
 * The other two are switches because they genuinely start off and staying off
 * is a complete answer. Neither is required to continue.
 *
 * ── Why the AI decline is not a dead end ─────────────────────────
 *
 * Declining is a normal choice, so the screen says what still works rather
 * than what is lost. Capture runs on rules and tells the user it did.
 */
export type AiAnswer = 'granted' | 'declined' | null;

export interface ConsentChoices {
  ai: AiAnswer;
  recommendations: boolean;
  analytics: boolean;
}

export function ConsentStep({
  choices,
  onChange,
  onContinue,
  onBack,
  saving = false,
  failed = false,
  ready = true,
}: {
  choices: ConsentChoices;
  /**
   * An updater, not a value. Each control used to build its next state from
   * the `choices` captured at render, so answering the AI question and
   * flicking a switch in the same batch made the second write clobber the
   * first — and the answer that vanished was the AI one.
   */
  onChange: (update: (previous: ConsentChoices) => ConsentChoices) => void;
  onContinue: () => void;
  onBack: () => void;
  saving?: boolean;
  failed?: boolean;
  /**
   * The server has said which consent versions it recognises. Until it has,
   * there is nothing honest to record — a guessed version is refused, and a
   * hard-coded one would claim agreement to words this build cannot prove were
   * shown. So Continue waits rather than failing with "nothing was changed",
   * which would blame the network for a request never made.
   */
  ready?: boolean;
}) {
  const { t, p } = useApp();
  const answered = choices.ai !== null;

  return (
    <OnboardingChrome
      step="consent"
      title={t.obConsentTitle}
      testID="onboarding-consent"
      primary={{
        label: saving ? t.obConsentSaving : failed ? t.obConsentRetry : t.obContinue,
        onPress: onContinue,
        disabled: !answered || saving || !ready,
      }}
      secondary={{ label: t.obBack, onPress: onBack }}
      footNote={failed ? t.obConsentFailed : answered ? undefined : t.obConsentNeedAi}
    >
      <Txt size={15} color={p.mu} lh={1.5}>{t.obConsentLede}</Txt>

      {/* ── AI processing ─────────────────────────────────────────── */}
      <Card pad={18} style={{ gap: 12 }}>
        <Txt size={17} weight={600}>{t.obAiTitle}</Txt>
        {[t.obAiWhatIsSent, t.obAiToWhom, t.obAiWhy, t.obAiNotSent].map(line => (
          <Txt key={line} size={14} color={p.mu} lh={1.5}>{line}</Txt>
        ))}
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={t.obAiTitle}
          style={{ flexDirection: 'row', gap: 10, paddingTop: 4 }}
        >
          <ChoiceButton
            label={t.obAiAllow}
            selected={choices.ai === 'granted'}
            onPress={() => onChange(previous => ({ ...previous, ai: 'granted' }))}
          />
          <ChoiceButton
            label={t.obAiDecline}
            selected={choices.ai === 'declined'}
            onPress={() => onChange(previous => ({ ...previous, ai: 'declined' }))}
          />
        </View>
        {choices.ai === 'declined' ? (
          <Txt size={13} color={p.mu} lh={1.5} testID="onboarding-ai-declined-note">{t.obAiDeclinedNote}</Txt>
        ) : null}
      </Card>

      {/* ── The two switches ──────────────────────────────────────── */}
      <ToggleRow
        title={t.obRecTitle}
        body={t.obRecBody}
        value={choices.recommendations}
        onChange={value => onChange(previous => ({ ...previous, recommendations: value }))}
      />
      <ToggleRow
        title={t.obAnalyticsTitle}
        body={t.obAnalyticsBody}
        value={choices.analytics}
        onChange={value => onChange(previous => ({ ...previous, analytics: value }))}
      />
    </OnboardingChrome>
  );
}

/**
 * One of two equal answers. `accessibilityRole="radio"` with `checked`, so a
 * screen reader says which is chosen — and says neither is, before one is.
 */
function ChoiceButton({
  label, selected, onPress,
}: { label: string; selected: boolean; onPress: () => void }) {
  const { p } = useApp();
  return (
    <Btn
      onPress={onPress}
      label={label}
      scaleTo={0.97}
      style={{
        flex: 1,
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
        borderRadius: 14,
        borderWidth: selected ? 0 : 1,
        borderColor: p.ln,
        backgroundColor: selected ? p.acs : 'transparent',
      }}
    >
      <Txt size={14} weight={selected ? 600 : 400} align="center" color={selected ? p.ac : p.tx}>{label}</Txt>
    </Btn>
  );
}

function ToggleRow({
  title, body, value, onChange,
}: { title: string; body: string; value: boolean; onChange: (value: boolean) => void }) {
  const { p } = useApp();
  return (
    <Card pad={18} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Txt size={17} weight={600} style={{ flex: 1 }}>{title}</Txt>
        <Switch
          accessibilityRole="switch"
          accessibilityLabel={title}
          value={value}
          onValueChange={onChange}
          trackColor={{ false: p.ln, true: p.ac }}
        />
      </View>
      <Txt size={14} color={p.mu} lh={1.5}>{body}</Txt>
    </Card>
  );
}
