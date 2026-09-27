import React from 'react';
import { Linking, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Card, Pill, Txt } from '../../ui/primitives';
import type { HealthKitReadinessNativeModule } from '../../../modules/healthkit-readiness';
import { useHealthReadiness, type HealthCardState } from './useHealthReadiness';

/**
 * «استعمل بيانات الصحة» on the energy screen (Health → energy).
 *
 * One card, every state in words: what Health gives, whether it is connected,
 * and when it is not, what the user can do about it. The readiness card above
 * it is where the result shows — the band and "using a recent readiness
 * signal" — so this card only speaks for the connection.
 */
const STATUS_COPY: Partial<Record<HealthCardState, 'readinessHealthReading' | 'readinessHealthConnected' | 'readinessHealthNoData' | 'readinessHealthDenied' | 'readinessHealthUnavailable' | 'readinessHealthFailed'>> = {
  working: 'readinessHealthReading',
  connected: 'readinessHealthConnected',
  noData: 'readinessHealthNoData',
  denied: 'readinessHealthDenied',
  unavailable: 'readinessHealthUnavailable',
  failed: 'readinessHealthFailed',
};

/**
 * Where the user changes a Health permission. iOS keeps read permissions in
 * the Health app, not in this app's Settings page; Settings is the fallback
 * when the Health app cannot be opened.
 */
async function openHealthPermissions(): Promise<void> {
  try {
    await Linking.openURL('x-apple-health://');
  } catch {
    await Linking.openSettings().catch(() => undefined);
  }
}

export function HealthDataCard({ nativeModule, platform, now }: {
  nativeModule?: HealthKitReadinessNativeModule | null;
  platform?: string;
  now?: () => Date;
} = {}) {
  const { t, p } = useApp();
  const health = useHealthReadiness({
    ...(nativeModule !== undefined ? { nativeModule } : {}),
    ...(platform !== undefined ? { platform } : {}),
    ...(now !== undefined ? { now } : {}),
  });
  const { state, connected } = health;
  if (state === 'hidden') return null;

  const statusKey = STATUS_COPY[state];
  const working = state === 'working';
  // "No data yet" is not a problem to flag (closure CL2b, D5): Health is
  // connected and simply has nothing from the last day. Only a refusal or a
  // real failure takes the attention colour.
  const warn = state === 'denied' || state === 'failed';

  return (
    <Card pad={18} style={{ gap: 10 }} testID="health-card">
      <Txt size={15} weight={600}>{t.readinessHealthTitle}</Txt>
      <Txt size={13} color={p.mu} lh={1.5}>{t.readinessHealthBody}</Txt>
      {statusKey ? (
        // A live region so a screen reader hears "Reading…" turn into the
        // result without having to find it.
        <View accessibilityLiveRegion="polite">
          <Txt size={13} color={warn ? p.wm : p.mu} lh={1.5} testID={`health-status-${state}`}>
            {t[statusKey]}
          </Txt>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {!connected && (state === 'idle' || state === 'failed' || state === 'denied' || working) ? (
          <Pill
            testID="health-connect"
            label={t.readinessHealthConnect}
            disabled={working}
            onPress={() => void health.connect()}
          />
        ) : null}
        {state === 'denied' || (connected && state === 'noData') ? (
          <Pill testID="health-open" label={t.readinessHealthOpen} kind="outline" onPress={() => void openHealthPermissions()} />
        ) : null}
        {connected && (state === 'connected' || state === 'noData' || state === 'failed' || working) ? (
          <Pill
            testID="health-refresh"
            label={t.readinessHealthRefresh}
            kind="outline"
            disabled={working}
            onPress={() => void health.refresh()}
          />
        ) : null}
        {connected ? (
          <Pill
            testID="health-disconnect"
            label={t.readinessHealthDisconnect}
            kind="ghost"
            disabled={working}
            onPress={() => void health.disconnect()}
          />
        ) : null}
      </View>
    </Card>
  );
}
