import { ClarityConsent } from '../../clarity/ClarityConsent';
import React from 'react';
import { Switch, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { userFacingMessageKey } from '../../api/ui/userFacingMessage';
import { Btn, Card, Txt } from '../../ui/primitives';
import { OnboardingChrome } from './OnboardingChrome';
import { ShieldGlyph } from './WelcomeStep';

/**
 * What MaybeSitter may use, on the way in (UC-2.9 #170, UC-2.R1 #171).
 *
 * ── AI processing is told, not asked ─────────────────────────────
 *
 * AI processing can no longer be declined (owner decision 2026-09-30): the
 * capture page is a chat on the model. So the first card is a disclosure with
 * nothing to press — who reads what the person writes or says, and what is
 * kept — shown here, before the first capture, where the consent question
 * used to be. Nothing about it is recorded: agreeing to words that were never
 * shown (the old version's "changeable in settings") would not be consent.
 *
 * The other two are switches because they genuinely start off and staying off
 * is a complete answer. Neither is required to continue.
 *
 * ── Three states per question, not two ───────────────────────────
 *
 * `recommendations` is `boolean | null`: a switch
 * the user turned **off** and a switch nobody has touched are different facts,
 * and a two-valued flag cannot hold the difference. It could not, and a
 * refetch that seeded from the account's earlier grant put the grant back over
 * an explicit decline — recording a consent the user had just withdrawn. The
 * switch renders `null` as off, which is what it looks like; only the flow
 * cares that nothing has been said yet.
 */
/** `null` means untouched: no answer given on this screen yet. */
export type ToggleAnswer = boolean | null;

export interface ConsentChoices {
  recommendations: ToggleAnswer;
  analytics: boolean;
}

export function ConsentStep({
  choices,
  onChange,
  onContinue,
  onBack,
  onRetry,
  saving = false,
  failed = false,
  ready = true,
  unreachable,
}: {
  choices: ConsentChoices;
  /**
   * An updater, not a value. Each control used to build its next state from
   * the `choices` captured at render, so two answers in the same batch made
   * the second write clobber the first.
   */
  onChange: (update: (previous: ConsentChoices) => ConsentChoices) => void;
  onContinue: () => void;
  onBack: () => void;
  /** Ask for the consent versions again. Present whenever `unreachable` is. */
  onRetry?: (() => void) | undefined;
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
  /**
   * Why the versions have not arrived, when asking for them failed.
   *
   * Waiting is still right. Waiting *silently, forever, with no way to try
   * again* was the defect: Continue stayed grey with nothing on screen to
   * explain it or to recover from it.
   */
  unreachable?: unknown;
}) {
  const { t, p } = useApp();
  const failedToFetch = unreachable !== undefined && unreachable !== null;

  return (
    <OnboardingChrome
      step="consent"
      title={t.obConsentTitle}
      testID="onboarding-consent"
      primary={{
        label: saving ? t.obConsentSaving : failed ? t.obConsentRetry : t.obContinue,
        onPress: onContinue,
        disabled: saving || !ready,
      }}
      secondary={{ label: t.obBack, onPress: onBack }}
      // The notice below carries the fetch failure, in `userFacingMessage`'s
      // words and next to the button that recovers from it; a centred line of
      // fine print with no control beside it would be the same dead end more
      // politely worded.
      footNote={
        failedToFetch ? undefined
          : failed ? t.obConsentFailed
            : !ready ? t.obConsentChecking
              : undefined
      }
    >
      {/* ── AI processing: told, before the first capture ─────────── */}
      {/* Spelled out here rather than through WelcomeStep's DisclosureCard:
          the census (aiAlwaysOnCensus) reads this file for both lines. */}
      <Card pad={16} style={{ gap: 8, backgroundColor: p.sf }} testID="onboarding-ai-disclosure">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ShieldGlyph color={p.ac} />
          <Txt role="section" size={17} weight={700} style={{ flexShrink: 1 }}>{t.aiDisclosureTitle}</Txt>
        </View>
        <Txt size={15} color={p.mu} lh={1.5}>{t.aiDisclosure}</Txt>
        <Txt size={15} weight={600} lh={1.5}>{t.aiDisclosureKept}</Txt>
      </Card>

      <Txt size={15} color={p.mu} lh={1.5}>{t.obConsentLede}</Txt>

      {failedToFetch ? (
        <Card pad={18} style={{ gap: 12 }} testID="onboarding-consent-unreachable">
          <Txt size={15} color={p.mu} lh={1.5}>{t[userFacingMessageKey(unreachable)]}</Txt>
          <Btn
            label={t.errorsRetry}
            testID="onboarding-consent-refetch"
            onPress={onRetry}
            style={{
              minHeight: 44,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 14,
              borderWidth: 1,
              borderColor: p.ln,
            }}
          >
            <Txt size={15} weight={600} color={p.ac}>{t.errorsRetry}</Txt>
          </Btn>
        </Card>
      ) : null}

      {/* ── The two switches ──────────────────────────────────────── */}
      <ToggleRow
        title={t.obRecTitle}
        body={t.obRecBody}
        value={choices.recommendations === true}
        onChange={value => onChange(previous => ({ ...previous, recommendations: value }))}
      />
      <ToggleRow
        title={t.obAnalyticsTitle}
        body={t.obAnalyticsBody}
        value={choices.analytics}
        onChange={value => onChange(previous => ({ ...previous, analytics: value }))}
      />
      <ClarityConsent card />
    </OnboardingChrome>
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
