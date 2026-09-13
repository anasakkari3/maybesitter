import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { isolate } from '../../i18n/bidi';
import { formatDate } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { Btn, Card, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { useFeedbackHistory, useRevokeFeedback } from '../../api/queries';
import { SettingsHeader } from './SettingsChrome';

/**
 * What MaybeSitter learned from the user, and the way to take it back
 * (UC-2.R4, #174).
 *
 * ── Revoked rows stay ────────────────────────────────────────────
 *
 * A revoked row is not removed from the list. It is the visible evidence that
 * the correction was applied; dropping it would ask the user to take our word
 * for it, on the one screen that exists because they might not.
 *
 * ── Unreachable is not an error ──────────────────────────────────
 *
 * A 503 here means the feedback service is down, not that anything went wrong
 * with the user's data. The screen says it cannot reach this right now and
 * that nothing changed, rather than showing a generic failure that reads like
 * something was lost.
 */
export function FeedbackHistoryScreen({ onBack }: { onBack: () => void }) {
  const { t, p, lang } = useApp();
  const insets = useSafeAreaInsets();
  const timeZone = useTimeZone();
  const history = useFeedbackHistory();
  const revoke = useRevokeFeedback();
  const [confirming, setConfirming] = useState<string | null>(null);

  const rows = history.data?.rows ?? [];
  const strings = t as unknown as Record<string, string>;

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 60, gap: 14 }}>
        <SettingsHeader title={t.feedbackHistoryTitle} onBack={onBack} />

        {history.isError ? (
          <Card pad={18}>
            <Txt size={14} color={p.mu} lh={1.5} testID="feedback-history-unavailable">
              {t.feedbackHistoryUnavailable}
            </Txt>
          </Card>
        ) : history.data === undefined ? null : rows.length === 0 ? (
          <Card pad={18}>
            <Txt size={14} color={p.mu} lh={1.5} testID="feedback-history-empty">{t.feedbackHistoryEmpty}</Txt>
          </Card>
        ) : (
          <Card pad={0} style={{ overflow: 'hidden' }}>
            {rows.map((row, index) => (
              <View
                key={row.id}
                testID={`feedback-row-${row.id}`}
                style={{
                  paddingHorizontal: 18, paddingVertical: 14, gap: 6,
                  borderTopWidth: index === 0 ? 0 : 1, borderTopColor: p.ln,
                }}
              >
                <Txt size={15}>{isolate(strings[`feedbackOutcome_${row.outcome}`] ?? row.outcome)}</Txt>
                <Txt size={13} color={p.mu} latin>{formatDate(new Date(row.occurredAt), 'short', { locale: lang, timeZone })}</Txt>
                {row.revokedAt ? (
                  <Txt size={13} color={p.mu} testID={`feedback-revoked-${row.id}`}>{t.feedbackRevoked}</Txt>
                ) : row.canRevoke ? (
                  confirming === row.id ? (
                    <View style={{ flexDirection: 'row', gap: 12 }}>
                      <Btn
                        label={t.feedbackRevoke}
                        testID={`feedback-revoke-confirm-${row.id}`}
                        onPress={() => { setConfirming(null); revoke.mutate(row.id); }}
                        hitSlop={8}
                        style={{ minHeight: 32, justifyContent: 'center' }}
                      >
                        <Txt size={14} color={p.wm}>{t.feedbackRevoke}</Txt>
                      </Btn>
                      <Btn
                        label={t.cancel}
                        onPress={() => setConfirming(null)}
                        hitSlop={8}
                        style={{ minHeight: 32, justifyContent: 'center' }}
                      >
                        <Txt size={14} color={p.mu}>{t.cancel}</Txt>
                      </Btn>
                    </View>
                  ) : (
                    <Btn
                      label={t.feedbackRevoke}
                      testID={`feedback-revoke-${row.id}`}
                      onPress={() => setConfirming(row.id)}
                      hitSlop={8}
                      style={{ alignItems: 'flex-start', minHeight: 32, justifyContent: 'center' }}
                    >
                      <Txt size={14} color={p.ac}>{t.feedbackRevoke}</Txt>
                    </Btn>
                  )
                ) : null}
              </View>
            ))}
          </Card>
        )}

        {history.data?.baselineNotice ? (
          <Card pad={18}>
            <Txt size={13} color={p.mu} lh={1.5} testID="feedback-baseline">
              {history.data.baselineNotice.note}
            </Txt>
          </Card>
        ) : null}
      </ScrollView>
    </ScreenIn>
  );
}
