import React from 'react';
import { ScrollView, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { icsFeedsEnabled } from '../../config/env';
import { Card, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { SettingsHeader, SettingsRow } from './SettingsChrome';

/**
 * Sources (Round 2, Phase I): the things that can put commitments into a day
 * on their own — subscribed calendar links and followed football clubs — in
 * one place, so "why is this in my day?" has one answer.
 *
 * Calendar links stay behind their build flag: a row that leads to a screen
 * that refuses is worse than no row.
 */
export function SourcesScreen({ onBack }: { onBack: () => void }) {
  const { t, p, actions } = useApp();
  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 60, gap: 16 }}>
        <SettingsHeader title={t.sourcesTitle} onBack={onBack} />
        <Txt size={14} color={p.mu} lh={1.5}>{t.sourcesBody}</Txt>
        <Card pad={0} style={{ paddingHorizontal: 16 }}>
          {icsFeedsEnabled() ? (
            <SettingsRow first label={t.icsFeedsEntry} onPress={() => actions.go('calendarFeeds')} testID="sources-calendar-links" />
          ) : null}
          <SettingsRow first={!icsFeedsEnabled()} label={t.footballTitle} onPress={() => actions.go('footballSettings')} testID="settings-football" />
        </Card>
        <View />
      </ScrollView>
    </ScreenIn>
  );
}
