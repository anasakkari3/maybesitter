import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { useReadiness, useSaveSubjectiveEnergy } from '../../api/queries';
import { Btn, Card, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { SettingsHeader } from './SettingsChrome';

const ENERGY = [1, 2, 3, 4, 5] as const;
const BAND_COPY = {
  unknown: 'readinessBandUnknown',
  low: 'readinessBandLow',
  steady: 'readinessBandSteady',
  high: 'readinessBandHigh',
} as const;
const SOURCE_COPY = {
  current_subjective: 'readinessSourceCurrentSubjective',
  recent_readiness: 'readinessSourceRecentReadiness',
  historical_inference: 'readinessSourceHistoricalInference',
  none: 'readinessSourceNone',
} as const;
const FRESHNESS_COPY = {
  fresh: 'readinessFreshnessFresh',
  stale: 'readinessFreshnessStale',
  none: 'readinessFreshnessNone',
} as const;

export function ReadinessSettingsScreen({ onBack }: { onBack: () => void }) {
  const { t, p } = useApp();
  const insets = useSafeAreaInsets();
  const readiness = useReadiness();
  const save = useSaveSubjectiveEnergy();
  const [failed, setFailed] = useState(false);

  const snapshot = readiness.data?.readiness ?? null;
  const currentEnergy = snapshot?.subjective?.energy ?? null;
  const band = snapshot?.band ?? 'unknown';
  const selectedSource = readiness.data?.selectedSource ?? 'none';
  const freshness = readiness.data?.freshness ?? 'none';

  const chooseEnergy = async (energy: 1 | 2 | 3 | 4 | 5) => {
    setFailed(false);
    try {
      await save.mutateAsync({ energy, observedAt: new Date().toISOString() });
    } catch {
      setFailed(true);
    }
  };

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 80, gap: 14 }}>
        <SettingsHeader title={t.settingsEnergy} onBack={onBack} />
        <Card pad={18} style={{ gap: 14 }}>
          <View style={{ gap: 6 }}>
            <Txt size={15} weight={600}>{t.readinessEnergyTitle}</Txt>
            <Txt size={13} color={p.mu} lh={1.5}>{t.readinessEnergyBody}</Txt>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {ENERGY.map(energy => {
              const active = currentEnergy === energy;
              return (
                <Btn
                  key={energy}
                  label={`${t.readinessEnergyTitle} ${energy}`}
                  testID={`readiness-energy-${energy}`}
                  onPress={() => void chooseEnergy(energy)}
                  disabled={save.isPending}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    borderRadius: 14,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: active ? p.ac : p.bg,
                    borderWidth: 1,
                    borderColor: active ? p.ac : p.ln,
                  }}
                >
                  <Txt size={15} weight={600} color={active ? p.onAccent : p.tx} latin>{energy}</Txt>
                </Btn>
              );
            })}
          </View>
          {failed ? <Txt size={13} color={p.wm} testID="readiness-save-failed">{t.readinessSaveFailed}</Txt> : null}
        </Card>

        <Card pad={18} style={{ gap: 10 }}>
          <Txt size={15} weight={600}>{t.readinessStatusTitle}</Txt>
          {readiness.isLoading ? (
            <Txt size={13} color={p.mu} testID="readiness-loading">{t.readinessLoading}</Txt>
          ) : readiness.isError ? (
            <Txt size={13} color={p.mu} testID="readiness-unavailable">{t.readinessUnavailable}</Txt>
          ) : (
            <View style={{ gap: 6 }}>
              <Txt size={14} testID="readiness-band">{t[BAND_COPY[band]]}</Txt>
              <Txt size={13} color={p.mu} testID="readiness-source">
                {t[SOURCE_COPY[selectedSource]]}
              </Txt>
              <Txt size={13} color={p.mu} testID="readiness-freshness">
                {t[FRESHNESS_COPY[freshness]]}
              </Txt>
            </View>
          )}
        </Card>

        <Txt size={12} color={p.mu} lh={1.5}>{t.readinessPrivacyNote}</Txt>
      </ScrollView>
    </ScreenIn>
  );
}
