import React, { useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { isolateAuto } from '../../i18n/bidi';
import { formatDate } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { Btn, Card, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
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
/** The five answers, each with words a person wrote. */
const DECISION_KEY: Record<string, string> = {
  accept: 'historyDecisionAccept',
  edit: 'historyDecisionEdit',
  defer: 'historyDecisionDefer',
  dismiss: 'historyDecisionDismiss',
  done: 'historyDecisionDone',
};

export function FeedbackHistoryScreen({ onBack }: { onBack: () => void }) {
  const { t, p, lang } = useApp();
  const timeZone = useTimeZone();
  const history = useFeedbackHistory();
  const revoke = useRevokeFeedback();
  const [confirming, setConfirming] = useState<string | null>(null);

  const rows = history.data?.rows ?? [];
  const decisions = history.data?.nextStepDecisions ?? [];
  const strings = t as unknown as Record<string, string>;

  return (
    <Screen pinned={<SettingsHeader title={t.feedbackHistoryTitle} onBack={onBack} />}>
      <ScreenScroll>

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
                <Txt size={15}>{isolateAuto(strings[`feedbackOutcome_${row.outcome}`] ?? row.outcome)}</Txt>
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
        {/*
          * The user's own answers to next steps (#170, #174).
          *
          * A separate section, not merged into the rows above. A behaviour row
          * is an observation the system made and offers to revoke; a decision
          * is a choice the person made, and there is nothing about it to
          * correct. Listing them together under one heading would tell somebody
          * their own decision was something we inferred about them.
          */}
        {history.data !== undefined && !history.isError ? (
          <>
            <Txt size={13} weight={600} color={p.mu} style={{ paddingHorizontal: 4, paddingTop: 6 }}>
              {t.historyDecisionsTitle}
            </Txt>
            {decisions.length === 0 ? (
              <Card pad={18}>
                <Txt size={14} color={p.mu} lh={1.5} testID="history-decisions-empty">
                  {t.historyDecisionsEmpty}
                </Txt>
              </Card>
            ) : (
              <Card pad={0} style={{ overflow: 'hidden' }} testID="history-decisions">
                {decisions.map((decision, index) => (
                  <View
                    key={`${decision.proposalId}-${decision.at}`}
                    testID={`history-decision-${decision.decision}`}
                    style={{
                      paddingHorizontal: 18, paddingVertical: 14, gap: 6,
                      borderTopWidth: index === 0 ? 0 : 1, borderTopColor: p.ln,
                    }}
                  >
                    {/* An answer this build has no words for is skipped rather
                        than printed as its enum. */}
                    <Txt size={15}>
                      {isolateAuto(strings[DECISION_KEY[decision.decision] ?? ''] ?? '')}
                    </Txt>
                    <Txt size={13} color={p.mu} latin>
                      {formatDate(new Date(decision.at), 'short', { locale: lang, timeZone })}
                    </Txt>
                  </View>
                ))}
              </Card>
            )}
          </>
        ) : null}
      </ScreenScroll>
    </Screen>
  );
}
