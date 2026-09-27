import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useSourcesAvailability } from './sourcesAvailability';
import { Card, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import { SettingsHeader, SettingsRow } from './SettingsChrome';

/**
 * Sources (Round 2, Phase I): the things that can put commitments into a day
 * on their own — subscribed calendar links and followed football clubs — in
 * one place, so "why is this in my day?" has one answer.
 *
 * Calendar links stay behind their build flag: a row that leads to a screen
 * that refuses is worse than no row. Football shows only when the server holds
 * the match data key (closure CL7) — without it nothing is ever fetched.
 */
export function SourcesScreen({ onBack }: { onBack: () => void }) {
  const { t, p, actions } = useApp();
  const sources = useSourcesAvailability();
  return (
    <Screen pinned={<SettingsHeader title={t.sourcesTitle} onBack={onBack} />}>
      <ScreenScroll gap={16}>
        <Txt size={14} color={p.mu} lh={1.5}>{t.sourcesBody}</Txt>
        <Card pad={0} style={{ paddingHorizontal: 16 }}>
          {sources.ics ? (
            <SettingsRow first label={t.icsFeedsEntry} onPress={() => actions.go('calendarFeeds')} testID="sources-calendar-links" />
          ) : null}
          {sources.football ? (
            <SettingsRow first={!sources.ics} label={t.footballTitle} onPress={() => actions.go('footballSettings')} testID="settings-football" />
          ) : null}
        </Card>
        <View />
      </ScreenScroll>
    </Screen>
  );
}
