import React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLayoutMode } from '../theme/textScale';
import { useApp } from '../state/AppContext';
import { useTimeZone } from '../i18n/timezone';
import { formatRelativeDay, formatTime } from '../i18n/format';
import { ltr } from '../i18n/strings';
import { useActivity, useCategoryPreferences, useCommitment, useCommitmentAction, usePatchCommitment } from '../api/queries';
import { safeCommitmentPatchEnabled } from '../config/env';
import { QueryBoundary } from '../api/ui/QueryBoundary';
import { NotFoundError } from '../api/errors';
import { toViewModel, type CommitmentView } from '../features/commitments/model';
import { impLabel } from '../state/derive';
import type { CommitmentCategory } from '../features/commitments/categoryFilter';
import { activityKindLabel } from '../features/activity/ActivityScreen';
import { BusyConflictChip } from '../features/calendar/BusyConflictChip';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import { busyAt } from '../features/calendar/conflicts';
import { Btn, Card, Pill, Txt } from '../ui/primitives';
import { ActionRow, BackButton, EmptyState, SectionLabel, Tag } from '../ui/chrome';
import { Screen, ScreenScroll } from '../ui/screen';

/**
 * One commitment, from the account (UC-2.R3 #173; Round 2, Phase E).
 *
 * ── Four actions, and each one is a real transition ──────────────
 *
 * Done, not now, edit and drop-on-purpose, on the actions route the server
 * implements. Delete sits apart, because it is the one thing here that does
 * not keep the commitment in the user's history.
 *
 * ── Reopen is missing on purpose ─────────────────────────────────
 *
 * Round 2 draws «لسّا» on a finished commitment. The actions route accepts
 * `complete | postpone | cancel | aware` and nothing else, so the button would
 * be a control that fails. #173 records this as a backend follow-up, and the
 * feature matrix names it as a gap rather than drawing it.
 *
 * ── Edit is behind `features.safeCommitmentPatch` ────────────────
 *
 * Off, and the control is not drawn at all rather than drawn and refused.
 *
 * ── Its history is the account's history ─────────────────────────
 *
 * The activity feed carries a `commitmentId` per event, so the events about
 * this one are shown under it — from the same query Activity reads, first
 * page only. No new route, no second copy.
 *
 * ── Round 2's "source" row is not drawn ──────────────────────────
 *
 * The export shows where a commitment came from (a capture, a share, the
 * routine). The commitment contract carries no provenance field — the only
 * `source` on it is the priority's — so the row would have to be invented.
 * It is left out and recorded in the matrix.
 */
export function DetailsScreen() {
  const { s, t, p, lang, actions } = useApp();
  const insets = useSafeAreaInsets();
  const stacked = useLayoutMode() !== 'normal';
  const timezone = useTimeZone();
  const query = useCommitment(s.detailId);
  const act = useCommitmentAction();
  const busy = useBusyBlocks();
  const activity = useActivity();

  const view = query.data ? toViewModel(query.data, new Date().toISOString()) : null;
  const gone = query.error instanceof NotFoundError;
  const open = view?.status === 'active';

  const preferences = useCategoryPreferences();
  const patch = usePatchCommitment();
  const filePicked = (category: CommitmentCategory | null) => {
    if (!s.detailId) return;
    patch.mutate({ id: s.detailId, patch: { category } });
  };

  const complete = () => {
    if (!view) return;
    // Back to the list, then the line at the bottom says it is done (Round 2).
    act.mutate({ id: view.id, action: 'complete' }, { onSuccess: () => { actions.back(); actions.toast(t.toastDone); } });
  };

  const history = (activity.data?.pages ?? [])
    .flatMap((page) => page.items)
    .filter((item) => item.commitmentId === s.detailId)
    .map((item) => ({ id: item.id, label: activityKindLabel(item.kind, t), at: new Date(item.at) }))
    .filter((item): item is { id: string; label: string; at: Date } => item.label !== null)
    .slice(0, 8);

  const strings = t as unknown as Record<string, string>;
  const category = query.data?.category ?? null;

  const controls = (view && !gone ? (
        <View style={{ paddingTop: 12, paddingHorizontal: 16, paddingBottom: insets.bottom + 8, gap: 8, borderTopWidth: 1, borderTopColor: p.ln, backgroundColor: p.bg }}>
          {open ? (
            <>
              <ActionRow>
                <Pill testID="details-done" label={t.done} onPress={complete} disabled={act.isPending} radius={20} pad={14} size={15} />
                <Pill testID="details-postpone" label={t.notNow} onPress={actions.openPostpone} disabled={act.isPending} kind="outline" radius={20} pad={14} size={15} />
              </ActionRow>
              <Pill testID="details-drop" label={t.dropIt} onPress={actions.openConfirmDrop} disabled={act.isPending} kind="warm" radius={20} pad={12} size={15} />
              <Pill testID="details-delete" label={t.detailsDelete} onPress={actions.openConfirmDelete} kind="ghost" size={14} radius={20} pad={10} />
            </>
          ) : (
            <Pill testID="details-delete" label={t.detailsDelete} onPress={actions.openConfirmDelete} kind="outline" radius={20} pad={14} size={15} />
          )}
        </View>
      ) : null);

  return (
    <Screen
      pinned={(
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <BackButton label={t.back} onPress={actions.back} />
          {view && open && safeCommitmentPatchEnabled() ? (
            <Btn testID="details-edit" label={t.detailsEdit} onPress={actions.openEdit} style={{ minHeight: 44, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 16, justifyContent: 'center' }}>
              <Txt size={13} weight={600}>{t.detailsEdit}</Txt>
            </Btn>
          ) : null}
        </View>
      )}
    >
      <ScreenScroll grow bottom={20} gap={16} topGap={14}>

        {gone ? (
          <EmptyState testID="details-gone" title={t.detailsNotFoundTitle} body={t.detailsNotFoundBody} top={60} />
        ) : (
          <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
            {view ? (
              <>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Tag kind={view.importance === 'must' ? 'must' : view.importance === 'should' ? 'should' : 'muted'} label={impLabel(view.importance, t)} testID="details-importance" />
                  <Tag kind="muted" label={statusLabel(view, t)} testID="details-status" />
                  {category ? <Tag kind="should" label={strings[CATEGORY_LABEL[category]]!} /> : null}
                </View>

                <View style={{ alignItems: 'flex-start' }}><Txt role="page" testID="details-title">{view.title}</Txt></View>
                {query.data?.description ? (
                  <Txt size={15} color={p.mu} lh={1.5} testID="details-description">{query.data.description}</Txt>
                ) : null}

                <Card pad={0} style={{ paddingVertical: 4, paddingHorizontal: 18 }}>
                  <Row label={t.dayLabel} testID="details-day">
                    {view.shownAt ? formatRelativeDay(new Date(view.shownAt), { locale: lang, timeZone: timezone }) : t.noTimeYet}
                  </Row>
                  <Row label={t.timeLabel} testID="details-time" latin>
                    {view.shownAt ? ltr(formatTime(new Date(view.shownAt), { locale: lang, timeZone: timezone })) : t.noTimeYet}
                  </Row>
                  {/* Shown whether or not there is one (#415): the ones the
                      model could not read are the ones worth correcting. */}
                  <CategoryRow
                    category={category}
                    enabled={preferences.data?.categoryPreferences.enabled ?? []}
                    onPick={filePicked}
                    disabled={patch.isPending}
                    canEdit={safeCommitmentPatchEnabled() && open}
                  />
                </Card>

                {/* What else is happening then (UC-3.2, #186), as a note. */}
                <BusyConflictChip blocks={view.shownAt ? busyAt(view.shownAt, busy) : []} testID="details-busy" />

                {!open ? <Txt size={13} color={p.mu} testID="details-closed-note">{t.detailsClosedNote}</Txt> : null}

                {history.length > 0 ? (
                  <View style={{ gap: 6 }}>
                    <SectionLabel>{t.detailsHistory}</SectionLabel>
                    <Card pad={0} style={{ paddingVertical: 4, paddingHorizontal: 16 }} testID="details-history">
                      {history.map((item, index) => (
                        <View key={item.id} style={{ flexDirection: stacked ? 'column' : 'row', justifyContent: 'space-between', gap: 8, paddingVertical: 14, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: p.ln }}>
                          <Txt size={14}>{item.label}</Txt>
                          <Txt size={13} color={p.mu} latin>{`${formatRelativeDay(item.at, { locale: lang, timeZone: timezone })} · ${ltr(formatTime(item.at, { locale: lang, timeZone: timezone }))}`}</Txt>
                        </View>
                      ))}
                    </Card>
                  </View>
                ) : null}
              </>
            ) : null}
          </QueryBoundary>
        )}
        {stacked ? controls : null}
      </ScreenScroll>

      {!stacked ? controls : null}
    </Screen>
  );
}

function statusLabel(view: CommitmentView, t: { doneS: string; dropped: string; statusPostponed: string; active: string }): string {
  if (view.status === 'done') return t.doneS;
  if (view.status === 'dropped') return t.dropped;
  return t.active;
}

/**
 * The category, named and changeable (#415). Always drawn; says "no
 * category" when there is none. The picker opens in place rather than in a
 * sheet, because filing something is a one-tap correction made while reading
 * the commitment. Only the categories the account uses are offered, plus a
 * way to clear.
 */
function CategoryRow({ category, enabled, onPick, disabled, canEdit }: {
  category: CommitmentCategory | null;
  enabled: readonly CommitmentCategory[];
  onPick: (category: CommitmentCategory | null) => void;
  disabled: boolean;
  canEdit: boolean;
}) {
  const { t, p } = useApp();
  const [open, setOpen] = React.useState(false);
  const strings = t as unknown as Record<string, string>;
  const label = category === null ? t.catNone : strings[CATEGORY_LABEL[category]]!;

  return (
    <View style={{ paddingVertical: 12 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Txt size={15} color={p.mu}>{t.catDetailsLabel}</Txt>
        {canEdit ? (
          <Btn testID="details-category-edit" label={t.catDetailsLabel} onPress={() => setOpen(current => !current)} disabled={disabled} scaleTo={0.97} style={{ paddingVertical: 6, paddingHorizontal: 2, minHeight: 44 }}>
            <Txt size={15} weight={600} color={p.acd} testID="details-category" style={{ textDecorationLine: 'underline', textDecorationColor: p.ul }}>{label}</Txt>
          </Btn>
        ) : (
          <Txt size={15} testID="details-category">{label}</Txt>
        )}
      </View>
      {open ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 12 }}>
          {enabled.map(candidate => (
            <Pill key={candidate} testID={`category-pick-${candidate}`} label={strings[CATEGORY_LABEL[candidate]]!} kind={candidate === category ? 'ink' : 'outline'} size={13} weight={500} pad={12} disabled={disabled} onPress={() => { setOpen(false); onPick(candidate); }} />
          ))}
          <Pill testID="category-pick-none" label={t.catNone} kind={category === null ? 'ink' : 'outline'} size={13} weight={500} pad={12} disabled={disabled} onPress={() => { setOpen(false); onPick(null); }} />
        </View>
      ) : null}
    </View>
  );
}

const CATEGORY_LABEL: Record<CommitmentCategory, string> = {
  work: 'catWork', family: 'catFamily', health: 'catHealth', finance: 'catFinance', social: 'catSocial', errands: 'catErrands',
};

function Row({ label, children, testID, latin }: { label: string; children: React.ReactNode; testID: string; latin?: boolean }) {
  const { p } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  return (
    <View style={{ flexDirection: stacked ? 'column' : 'row', justifyContent: 'space-between', gap: 8, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: p.ln }}>
      <Txt size={15} color={p.mu}>{label}</Txt>
      <Txt size={15} testID={testID} latin={latin}>{children}</Txt>
    </View>
  );
}
