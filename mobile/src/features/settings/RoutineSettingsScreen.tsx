import React, { useState } from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { useTimeZone } from '../../i18n/timezone';
import { usePutRoutine } from '../../api/queries';
import { RoutineStep } from '../onboarding/RoutineStep';
import { useRoutineSync } from '../routine/useRoutineSync';
import { EMPTY_ANSWERS, toRoutinePayload, type RoutineAnswers } from '../routine/routineProfile';
import { EMPTY_CACHE, loadRoutineCache, saveRoutineCache } from '../../lib/deviceSettings/routineCache';
import { SettingsHeader } from './SettingsChrome';

/**
 * The routine survey, reached from Settings (UC-2.R4 #174, questions from
 * UC-2.R1 #171).
 *
 * The same five questions and the same component, in `mode='settings'` — no
 * progress bar, no Skip, and Save instead of Continue. Two copies of the
 * survey UI is how the two would eventually come to ask different questions.
 *
 * Saving here goes through the same path onboarding uses, so an edit made in
 * Settings supersedes the routine facts exactly the way a first answer creates
 * them, and the disclosure line about syncing to the account is on this screen
 * too — changing an answer here syncs it just as much.
 */
export function RoutineSettingsScreen({ onBack }: { onBack: () => void }) {
  const { t, p } = useApp();
  const insets = useSafeAreaInsets();
  const timezone = useTimeZone();
  const putRoutine = usePutRoutine();
  const sync = useRoutineSync();
  const [answers, setAnswers] = useState<RoutineAnswers>(EMPTY_ANSWERS);
  const [seeded, setSeeded] = useState(false);
  const [failed, setFailed] = useState(false);

  // Seeded once from whichever copy `useRoutineSync` settled on, then owned by
  // this screen: a refetch mid-edit must not move a chip under the user's
  // finger.
  //
  // Adjusted during render, not in an effect — React's own advice for state
  // derived from a change in another value, and the pattern `AuthGate` uses.
  if (!seeded && !sync.loading && sync.answers !== null) {
    setSeeded(true);
    setAnswers(sync.answers);
  }

  const save = async () => {
    const payload = toRoutinePayload(answers, timezone, { skipped: false });
    let pendingSync = true;
    try {
      await putRoutine.mutateAsync(payload);
      pendingSync = false;
      setFailed(false);
    } catch {
      setFailed(true);
    }
    const cache = await loadRoutineCache();
    await saveRoutineCache({
      ...(cache ?? EMPTY_CACHE),
      answers,
      skipped: false,
      timezone,
      updatedAt: new Date().toISOString(),
      pendingSync,
    });
    if (!pendingSync) onBack();
  };

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 60, gap: 14 }}>
        <SettingsHeader title={t.settingsRoutine} onBack={onBack} />
        <RoutineStep
          mode="settings"
          answers={answers}
          onChange={setAnswers}
          onContinue={() => void save()}
        />
        {failed ? (
          <Txt size={13} color={p.mu} testID="routine-settings-failed">{t.obRoutineSaveFailed}</Txt>
        ) : null}
        <Btn
          label={t.memorySave}
          testID="routine-settings-save"
          onPress={() => void save()}
          style={{ backgroundColor: p.ac, borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center' }}
        >
          <Txt size={16} weight={600} color="#FFFFFF">{t.memorySave}</Txt>
        </Btn>
      </ScrollView>
    </ScreenIn>
  );
}
