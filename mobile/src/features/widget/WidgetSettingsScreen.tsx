/**
 * Settings → Home screen widget (UC-3.R1, #203).
 *
 * One switch, what it means, and a preview built by the *same* function that
 * writes the widget's snapshot — so what this screen shows is what the home
 * screen will show, not a drawing of it that can drift.
 *
 * The switch is `ServerToggle` although nothing here reaches a server: its
 * contract is "the position is the stored answer, and a write that did not
 * stick says so under the switch", which is exactly this setting's too. The
 * answer lives on the phone — see `lib/deviceSettings/widget.ts` for why.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../auth/AuthProvider';
import { useNextStep, useToday } from '../../api/queries';
import { formatTime } from '../../i18n/format';
import { ltr } from '../../i18n/strings';
import { useTimeZone } from '../../i18n/timezone';
import { Card, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { SettingsHeader } from '../settings/SettingsChrome';
import { ServerToggle } from '../settings/ServerToggle';
import { buildSnapshot, displayStateOf } from './snapshot';
import { widgetLabelsFor } from './labels';
import { useWidgetTitlesAllowed } from './useWidgetSnapshotSync';

export function WidgetSettingsScreen({ onBack }: { onBack: () => void }) {
  const { t, p, lang } = useApp();
  const insets = useSafeAreaInsets();
  const uid = useAuth().user?.uid ?? null;
  const { allowed, setAllowed } = useWidgetTitlesAllowed(uid);
  const timeZone = useTimeZone();
  const today = useToday();
  const nextStep = useNextStep();

  const now = new Date();
  const preview = today.isSuccess
    ? buildSnapshot({
      today: today.data.items,
      nextStep: nextStep.isSuccess ? nextStep.data.recommendation.primaryStep ?? null : null,
      titlesAllowed: allowed,
      surface: 'widget',
      locale: lang,
      labels: widgetLabelsFor(t),
      now,
      formatTime: (date) => formatTime(date, { locale: lang, timeZone }),
    })
    : null;
  const state = displayStateOf(preview, now);

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 60, gap: 14 }}>
        <SettingsHeader title={t.widgetSettingsTitle} onBack={onBack} />
        <Card pad={0}>
          <ServerToggle
            testID="widget-titles-toggle"
            title={t.widgetShowTitles}
            body={t.widgetShowTitlesBody}
            value={allowed}
            disabled={uid === null}
            onChange={setAllowed}
          />
        </Card>
        <Txt size={13} color={p.mu}>{t.widgetPreviewHeading}</Txt>
        <Card testID="widget-preview" style={{ gap: 10 }}>
          <Txt size={13} color={p.mu}>{t.widgetNextStep}</Txt>
          {state === 'populated' && preview ? (
            preview.items.map((item, index) => (
              <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: item.priority === 'must' ? p.wm : item.priority === 'should' ? p.ac : p.mu,
                  }}
                />
                <Txt
                  testID="widget-preview-item"
                  size={index === 0 ? 17 : 14}
                  weight={index === 0 ? 600 : 400}
                  color={item.titleRedacted ? p.mu : p.tx}
                  style={{ flex: 1 }}
                >
                  {item.title}
                </Txt>
                {item.timeLabel ? <Txt size={13} color={p.mu}>{ltr(item.timeLabel)}</Txt> : null}
              </View>
            ))
          ) : (
            <Txt size={15} color={p.mu}>{state === 'empty' ? t.widgetEmpty : t.widgetStale}</Txt>
          )}
        </Card>
      </ScrollView>
    </ScreenIn>
  );
}
