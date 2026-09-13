import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useTimeZone } from '../i18n/timezone';
import { formatRelativeDay, formatTime } from '../i18n/format';
import { ltr } from '../i18n/strings';
import { useCommitment, useCommitmentAction } from '../api/queries';
import { QueryBoundary } from '../api/ui/QueryBoundary';
import { NotFoundError } from '../api/errors';
import { toViewModel, type CommitmentView } from '../features/commitments/model';
import { Card, HeaderPill, ImpBadge, Pill, Txt } from '../ui/primitives';
import { ScreenIn } from '../ui/motion';

/**
 * One commitment, from the account (UC-2.R3, #173).
 *
 * ── Four actions, and each one is a real transition ──────────────
 *
 * Done, not now, edit and drop-on-purpose. The prototype's "Rearrange" sheet
 * offered "Intensify — same content, shorter time" and "Do less of it", which
 * are operations on a duration and a scope the domain does not have; picking
 * either only ever showed a toast. They are gone, and "not now" — the postpone
 * the actions route actually implements — is in their place.
 *
 * Delete sits apart from the rest, because it is the one thing here that does
 * not keep the commitment in the user's history.
 *
 * ── Reopen is missing on purpose ─────────────────────────────────
 *
 * Flutter's details screen had "mark pending". The actions route accepts
 * `complete | postpone | cancel` and nothing else, so the button would have
 * been a control that fails. #173 records this as a backend follow-up.
 */
export function DetailsScreen() {
  const { s, t, p, lang, actions } = useApp();
  const insets = useSafeAreaInsets();
  const timezone = useTimeZone();
  const query = useCommitment(s.detailId);
  const act = useCommitmentAction();

  const view = query.data ? toViewModel(query.data, new Date().toISOString()) : null;
  const gone = query.error instanceof NotFoundError;

  const complete = () => {
    if (!view) return;
    act.mutate({ id: view.id, action: 'complete' }, { onSuccess: () => actions.toast(t.toastDone) });
  };

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: insets.bottom + 24, gap: 18 }}>
        <View style={{ alignItems: 'flex-start' }}>
          <HeaderPill label={t.back} onPress={actions.back} />
        </View>

        {gone ? (
          <View style={{ gap: 8, paddingTop: 40 }} testID="details-gone">
            <Txt size={20} weight={600}>{t.detailsNotFoundTitle}</Txt>
            <Txt size={14} color={p.mu}>{t.detailsNotFoundBody}</Txt>
          </View>
        ) : (
          <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
            {view ? (
              <>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <ImpBadge imp={view.importance} />
                  <View style={{ backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 }}>
                    <Txt size={12} weight={600} color={p.mu} testID="details-status">{statusLabel(view, t)}</Txt>
                  </View>
                </View>

                <Txt size={26} weight={600} lh={1.4} testID="details-title">{view.title}</Txt>
                {query.data?.description ? (
                  <Txt size={15} color={p.mu} lh={1.5} testID="details-description">{query.data.description}</Txt>
                ) : null}

                <Card pad={0} style={{ paddingVertical: 6, paddingHorizontal: 18 }}>
                  <Row label={t.dayLabel} testID="details-day">
                    {view.shownAt
                      ? formatRelativeDay(new Date(view.shownAt), { locale: lang, timeZone: timezone })
                      : t.noTimeYet}
                  </Row>
                  <Row label={t.timeLabel} testID="details-time" last>
                    {view.shownAt
                      ? ltr(formatTime(new Date(view.shownAt), { locale: lang, timeZone: timezone }))
                      : t.noTimeYet}
                  </Row>
                </Card>

                {/* Done, not now and drop-on-purpose carry equal weight; only
                    delete is set apart, below the line. */}
                <View style={{ marginTop: 'auto', gap: 10 }}>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Pill
                      testID="details-done"
                      label={t.done}
                      onPress={complete}
                      disabled={act.isPending || view.status !== 'active'}
                      radius={20}
                      pad={18}
                      style={{ flex: 1 }}
                    />
                    <Pill
                      testID="details-postpone"
                      label={t.notNow}
                      onPress={actions.openPostpone}
                      disabled={act.isPending || view.status !== 'active'}
                      kind="outline"
                      radius={20}
                      pad={18}
                      style={{ flex: 1 }}
                    />
                  </View>
                  <Pill testID="details-edit" label={t.detailsEdit} onPress={actions.openEdit} kind="soft" radius={20} pad={18} />
                  <Pill
                    testID="details-drop"
                    label={t.dropIt}
                    onPress={actions.openConfirmDrop}
                    disabled={act.isPending || view.status !== 'active'}
                    kind="warm"
                    radius={20}
                    pad={18}
                  />
                  <Pill testID="details-delete" label={t.detailsDelete} onPress={actions.openConfirmDelete} kind="ghost" size={14} radius={20} pad={12} />
                </View>
              </>
            ) : null}
          </QueryBoundary>
        )}
      </ScrollView>
    </ScreenIn>
  );
}

function statusLabel(view: CommitmentView, t: { doneS: string; dropped: string; statusPostponed: string; active: string }): string {
  if (view.status === 'done') return t.doneS;
  if (view.status === 'dropped') return t.dropped;
  return t.active;
}

function Row({
  label, children, testID, last,
}: { label: string; children: React.ReactNode; testID: string; last?: boolean }) {
  const { p } = useApp();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: p.ln }}>
      <Txt size={15} color={p.mu}>{label}</Txt>
      <Txt size={15} testID={testID}>{children}</Txt>
    </View>
  );
}
