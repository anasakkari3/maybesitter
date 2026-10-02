import React, { useCallback, useState } from 'react';
import { useApp } from '../../state/AppContext';
import { Card, Txt } from '../../ui/primitives';
import { requestNotificationPermission, type NotificationPermission } from '../../notifications/permission';
import { OnboardingChrome } from './OnboardingChrome';

/**
 * What reminders will be like, and then the phone's own question
 * (UC-2.R1 #171; audit 2026-10-03 #7).
 *
 * This step used to explain reminders and ask nothing, leaving the system
 * prompt to the first timed commitment. On Android 13+ that prompt never came
 * (`permission.ts`, `canPromptFrom`), and the audit's phone finished
 * onboarding with POST_NOTIFICATIONS not granted and every reminder off.
 *
 * Now the explanation comes first and the prompt follows it, at the person's
 * own tap on «يلا نبلّش» — the moment they have just read what saying yes
 * means. «بعدين» finishes without asking, so the one prompt iOS allows is
 * never spent on someone who said not yet. The answer is the OS's to keep; a
 * no is not an error and changes nothing here — Settings → Reminders already
 * says reminders are blocked and opens the phone's settings, and
 * `RemindersMount` reports the permission to the server when the app opens.
 */
export function NotificationsStep({
  onDone, onBack, requestPermission = requestNotificationPermission,
}: {
  onDone: () => void;
  onBack: () => void;
  /** Injected by tests; the real one shows the system prompt only when it can. */
  requestPermission?: () => Promise<NotificationPermission>;
}) {
  const { t, p } = useApp();
  const [asking, setAsking] = useState(false);

  const start = useCallback(async () => {
    if (asking) return;
    setAsking(true);
    try {
      await requestPermission();
    } catch {
      // A prompt that could not be shown must not trap anyone on this screen.
    }
    onDone();
  }, [asking, onDone, requestPermission]);

  return (
    <OnboardingChrome
      step="notifications"
      title={t.obNotifTitle}
      testID="onboarding-notifications"
      primary={{ label: t.obDone, onPress: () => void start(), disabled: asking }}
      secondary={{ label: t.obBack, onPress: onBack }}
      headerAction={{ label: t.obNotifLater, onPress: onDone, testID: 'onboarding-notifications-later' }}
    >
      <Card pad={18}>
        <Txt size={15} color={p.mu} lh={1.5}>{t.obNotifBody}</Txt>
      </Card>
    </OnboardingChrome>
  );
}
