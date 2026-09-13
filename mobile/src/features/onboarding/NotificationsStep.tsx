import React from 'react';
import { useApp } from '../../state/AppContext';
import { Card, Txt } from '../../ui/primitives';
import { OnboardingChrome } from './OnboardingChrome';

/**
 * What reminders will be like — and nothing else (UC-2.R1, #171).
 *
 * This screen deliberately does **not** ask the OS for the notification
 * permission. Asking here, before the user has a single commitment, is the
 * prompt people deny: there is nothing yet to be reminded about, so "Allow"
 * has no meaning to say yes to. The request belongs to the S3 reminders issue,
 * at the moment a reminder is first actually wanted.
 *
 * So this is education, and the only two answers are "Start" and "Later" —
 * both of which finish onboarding.
 */
export function NotificationsStep({
  onDone, onBack,
}: { onDone: () => void; onBack: () => void }) {
  const { t, p } = useApp();
  return (
    <OnboardingChrome
      step="notifications"
      title={t.obNotifTitle}
      testID="onboarding-notifications"
      primary={{ label: t.obDone, onPress: onDone }}
      secondary={{ label: t.obBack, onPress: onBack }}
    >
      <Card pad={18}>
        <Txt size={15} color={p.mu} lh={1.5}>{t.obNotifBody}</Txt>
      </Card>
    </OnboardingChrome>
  );
}
