import React, { useState } from 'react';
import { ActivityIndicator, Switch, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Card, Txt } from '../../ui/primitives';
import { Notice, SectionLabel, Skeleton, Tag } from '../../ui/chrome';
import { Screen, ScreenScroll } from '../../ui/screen';
import { fillRow, useLayoutMode } from '../../theme/textScale';
import { useAnnounceOnIos } from '../../ui/announce';
import { LiveRegion } from '../../ui/liveRegion';
import { fill, ltr } from '../../i18n/strings';
import { toggleFailureKey, userFacingMessage, type UserFacingKey } from '../../api/ui/userFacingMessage';
import type { FeatureCapability } from '../../api/schemas/features';
import { SettingsHeader } from './SettingsChrome';
import {
  FEATURE_COPY, featureStatus, knownFeature, switchedOn, useFeatures, useSetFeatureEnabled,
} from './featureSettings';

/**
 * Settings → Features («الميزات»): what MaybeSitter does for this account, the
 * core first (always on, no switch), then the add-ons, each with its status in
 * a word, the person's own switch, and how much of this month's allowance is
 * used.
 *
 * Reached only while the server's gate is not `off` (`useFeaturesEntryShown`).
 * Ids this build has no words for are skipped rather than shown blank.
 */
export function FeaturesSettingsScreen({ onBack }: { onBack: () => void }) {
  const { t } = useApp();
  const features = useFeatures();
  const rows = (features.data?.features ?? []).filter(knownFeature);
  const core = rows.filter(feature => feature.tier === 'core');
  const addons = rows.filter(feature => feature.tier === 'addon');

  return (
    <Screen testID="features-settings" pinned={<SettingsHeader title={t.featuresTitle} onBack={onBack} />}>
      <ScreenScroll gap={10} bottom={48}>
        {features.isPending ? (
          <Skeleton heights={[96, 260]} label={t.featuresLoading} testID="features-loading" />
        ) : features.isError ? (
          <Notice
            testID="features-error"
            text={userFacingMessage(features.error, t)}
            action={t.errorsRetry}
            onAction={() => void features.refetch()}
          />
        ) : (
          <>
            {core.length > 0 ? (
              <>
                <SectionLabel testID="features-core-label">{t.featuresCoreSection}</SectionLabel>
                <Card pad={0} style={{ paddingHorizontal: 16 }} testID="features-core">
                  {core.map((feature, index) => <FeatureRow key={feature.id} feature={feature} first={index === 0} />)}
                </Card>
              </>
            ) : null}
            {addons.length > 0 ? (
              <>
                <SectionLabel testID="features-addon-label">{t.featuresAddonSection}</SectionLabel>
                <Card pad={0} style={{ paddingHorizontal: 16 }} testID="features-addons">
                  {addons.map((feature, index) => <FeatureRow key={feature.id} feature={feature} first={index === 0} />)}
                </Card>
              </>
            ) : null}
          </>
        )}
      </ScreenScroll>
    </Screen>
  );
}

/**
 * One feature: its name and what it does, its status in a word (a chip with a
 * text label, never colour alone), the person's switch when they may change
 * it, and the month's usage when the feature spends any.
 *
 * ── The switch moves at once, and comes back if the write fails ──
 *
 * The position the person chose shows immediately while the write is in
 * flight (disabled, with a spinner, so one tap sends at most one write). The
 * server's answer then replaces it; a failure puts the switch back where the
 * server has it and says why under the row, announced, in the words
 * `toggleFailureKey` gives every server-backed switch.
 *
 * The switch is the person's own choice, not whether the feature works: an
 * add-on they want but cannot use yet (no subscription, the month's allowance
 * spent) stays on, drawn in the warm attention colour, with the reason as its
 * hint — the same treatment `ServerToggle` gives a setting the phone blocks.
 */
function FeatureRow({ feature, first }: { feature: FeatureCapability; first: boolean }) {
  const { t, p } = useApp();
  const stacked = useLayoutMode() === 'xl';
  const setEnabled = useSetFeatureEnabled();
  const [pending, setPending] = useState<boolean | null>(null);
  const [failed, setFailed] = useState<UserFacingKey | null>(null);
  useAnnounceOnIos(failed ? t[failed] : null);

  const copy = FEATURE_COPY[feature.id]!;
  const name = t[copy.name];
  const status = featureStatus(feature);
  const statusText = t[status.key];
  const busy = pending !== null;
  const value = pending ?? switchedOn(feature);
  // On by choice, but not usable: warm, and the reason is the switch's hint.
  const blocked = value && !feature.enabled;
  const testID = `feature-${feature.id}`;

  const onValueChange = (next: boolean) => {
    if (busy) return;
    setPending(next);
    setFailed(null);
    setEnabled.mutateAsync({ id: feature.id, enabled: next })
      .catch((error: unknown) => setFailed(toggleFailureKey(error)))
      .finally(() => setPending(null));
  };

  return (
    <View
      testID={testID}
      style={{ paddingVertical: 16, gap: 8, minHeight: 60, borderTopWidth: first ? 0 : 1, borderTopColor: p.ln }}
    >
      <View style={{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center', gap: 12 }}>
        <View style={stacked ? { width: '100%', gap: 4, alignItems: 'flex-start' } : { ...fillRow, minWidth: 0, gap: 4, alignItems: 'flex-start' }}>
          <Txt size={16} weight={600} color={p.tx} testID={`${testID}-name`}>{name}</Txt>
          <Txt role="supporting" size={13} color={p.mu} testID={`${testID}-body`}>{t[copy.body]}</Txt>
        </View>
        {feature.userCanDisable && feature.tier !== 'core' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {busy ? <ActivityIndicator testID={`${testID}-busy`} color={p.ac} /> : null}
            <Switch
              testID={`${testID}-switch`}
              accessibilityRole="switch"
              accessibilityLabel={name}
              accessibilityHint={statusText}
              accessibilityState={{ checked: value, disabled: busy }}
              value={value}
              disabled={busy}
              trackColor={{ false: p.ln, true: blocked ? p.wm : p.ac }}
              thumbColor={value ? (blocked ? p.wm : p.ac) : p.sf}
              onValueChange={onValueChange}
            />
          </View>
        ) : null}
      </View>
      <Tag kind={status.kind} label={statusText} testID={`${testID}-status`} />
      {feature.usedPercent !== null ? <UsageMeter percent={feature.usedPercent} testID={`${testID}-usage`} /> : null}
      {/* Mounted before anything fails, so TalkBack hears the line arrive. */}
      <LiveRegion testID={`${testID}-failed-live`}>
        {failed ? <Txt size={13} color={p.wm} testID={`${testID}-failed`}>{t[failed]}</Txt> : null}
      </LiveRegion>
    </View>
  );
}

/**
 * This month's allowance used, as a bar and as words. The bar fills from the
 * start edge (the row's direction mirrors it), is drawn once with no motion,
 * and turns warm when the allowance is spent. Screen readers get one
 * progress element whose label is the sentence on screen.
 */
function UsageMeter({ percent, testID }: { percent: number; testID: string }) {
  const { t, p } = useApp();
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const label = fill(t.featuresUsage, { percent: ltr(`${clamped}%`) });
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: clamped }}
      style={{ gap: 6, alignSelf: 'stretch' }}
    >
      <View style={{ height: 6, borderRadius: 3, backgroundColor: p.sf2, overflow: 'hidden', flexDirection: 'row' }}>
        <View style={{ width: `${clamped}%`, backgroundColor: clamped >= 100 ? p.wm : p.ac, borderRadius: 3 }} />
      </View>
      <Txt size={13} color={p.mu} testID={`${testID}-text`}>{label}</Txt>
    </View>
  );
}
