import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLayoutMode } from '../theme/textScale';
import { useApp } from '../state/AppContext';
import { useTimeZone } from '../i18n/timezone';
import { formatRelativeDay, formatTime } from '../i18n/format';
import { ltr } from '../i18n/strings';
import { useActivity, useCategoryPreferences, useCommitment, useCommitmentAction, useNextStep, useNextStepDecision, usePatchCommitment, useSavedWeek } from '../api/queries';
import { safeCommitmentPatchEnabled } from '../config/env';
import { QueryBoundary } from '../api/ui/QueryBoundary';
import { NotFoundError } from '../api/errors';
import { clockOf, toViewModel, type CommitmentView } from '../features/commitments/model';
import { impLabel } from '../state/derive';
import type { CommitmentCategory } from '../features/commitments/categoryFilter';
import { activityKindLabel } from '../features/activity/ActivityScreen';
import { BusyConflictChip } from '../features/calendar/BusyConflictChip';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import { useConflictBusyBlocks } from '../features/google/useGoogle';
import { busyAt } from '../features/calendar/conflicts';
import { PlaceReminderSection } from '../features/places/PlaceReminderSection';
import { dueApart, placeView, savedPlacements } from '../features/plan/savedPlacement';
import { commitmentPrepTarget } from '../features/meetings/prepTargets';
import { Btn, Card, Pill, Txt } from '../ui/primitives';
import { ActionRow, BackButton, EmptyState, SectionLabel, Tag, priorityTagKind } from '../ui/chrome';
import { Screen, ScreenScroll } from '../ui/screen';
import { useReducedMotion } from '../ui/motion';
import { ReferenceIcon } from '../ui/referenceIcons';

/**
 * One commitment, from the account (UC-2.R3 #173; Round 2, Phase E).
 *
 * ── Four actions, and each one is a real transition ──────────────
 *
 * Done, not now, edit and drop-on-purpose, on the actions route the server
 * implements. Delete sits apart, because it is the one thing here that does
 * not keep the commitment in the user's history.
 *
 * Since the Stitch redesign (2026-10-02, `04b`): the two answers that keep it
 * — «خلصتها», «مش هلّق» — stay pinned under the scroller (N8); the two that
 * let it go are in the page under «ما عاد بدّك ياها؟», each saying what it
 * does to the history, each asked again in its own sheet. «بلّش فيها» shows
 * only when this commitment is the current next step (`StartIfProposed`).
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
  // The phone's busy time and Google's (CL6a review I1).
  const busy = useConflictBusyBlocks(useBusyBlocks());
  const activity = useActivity();
  // The place form opens in place, below everything else and above the pinned
  // actions; it is scrolled up into view when it opens (FX1).
  const scroll = React.useRef<ScrollView>(null);
  const placeY = React.useRef<number | null>(null);
  const reduced = useReducedMotion();
  const revealPlaceForm = React.useCallback(() => {
    if (placeY.current === null) return;
    scroll.current?.scrollTo({ y: Math.max(0, placeY.current - 8), animated: !reduced });
  }, [reduced]);

  // Where a saved week day puts it (FX1): said here as on Today and the Calendar.
  const savedWeek = useSavedWeek();
  const view = query.data ? placeView(toViewModel(query.data, new Date().toISOString()), savedPlacements(savedWeek.data)) : null;
  const planned = view?.plannedAt && (dueApart(view) || !view.shownAt) ? view.plannedAt : null;
  const gone = query.error instanceof NotFoundError;
  // Once the commitment is drawn, flash the scroll indicator (UAT round 2,
  // N8): the pinned actions take a quarter of the screen and the place
  // reminder, the category and the history sit below the fold with nothing
  // saying so. Once per screen.
  const drawn = view !== null;
  const flashed = React.useRef(false);
  React.useEffect(() => {
    if (!drawn || flashed.current) return;
    flashed.current = true;
    scroll.current?.flashScrollIndicators();
  }, [drawn]);
  const open = view?.status === 'active';
  // «حضّرني» (CL5a) on a meeting or an appointment that has not started.
  const prepTarget = query.data && open ? commitmentPrepTarget(query.data, new Date()) : null;

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
  const remindAt = query.data?.timeSpec.remindAt ?? null;
  const reminderAt = remindAt && remindAt !== query.data?.timeSpec.dueAt ? remindAt : null;

  // «خلصتها» and «مش هلّق», pinned below the scroller (N8): the two answers
  // that keep the commitment. Letting it go (drop, delete) is in the page, under
  // «ما عاد بدّك ياها؟», away from the thumb.
  const controls = (view && !gone && open ? (
        <View testID="details-actions" style={{ paddingTop: 12, paddingHorizontal: 16, paddingBottom: insets.bottom + 8, gap: 8, borderTopWidth: 1, borderTopColor: p.ln, backgroundColor: p.bg }}>
          <ActionRow>
            <Pill testID="details-done" label={t.nextStepDone} onPress={complete} disabled={act.isPending} size={15} pad={12} />
            <Pill testID="details-postpone" label={t.notNow} onPress={actions.openPostpone} disabled={act.isPending} kind="soft" size={15} pad={12} />
          </ActionRow>
        </View>
      ) : null);

  return (
    <Screen
      pinned={(
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }}>
            <BackButton label={t.back} onPress={actions.back} />
            {stacked ? null : <Txt role="section" size={18} weight={700} style={{ flexShrink: 1 }}>{t.detailsTitle}</Txt>}
          </View>
          {view && open && safeCommitmentPatchEnabled() ? (
            <Btn testID="details-edit" label={t.detailsEdit} onPress={actions.openEdit} scaleTo={0.94}
              style={{ minHeight: 44, minWidth: 44, borderRadius: 22, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <ReferenceIcon name="pencil" size={17} color={p.tx} />
              <Txt size={13} weight={600}>{t.detailsEdit}</Txt>
            </Btn>
          ) : null}
        </View>
      )}
    >
      {/* The place-name field (FY3 review I1): Details is not lifted by an
          AvoidKeyboard, so the scroller's own keyboard inset is the one that
          applies, and a tap on «احفظ التذكير» saves on the first press
          instead of only closing the keyboard. */}
      <ScreenScroll
        testID="details-scroll"
        grow
        bottom={20}
        gap={16}
        topGap={14}
        scrollRef={scroll}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >

        {gone ? (
          <EmptyState testID="details-gone" title={t.detailsNotFoundTitle} body={t.detailsNotFoundBody} top={60} />
        ) : (
          <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
            {view ? (
              <>
                {/* The commitment, as one card: its chips, its name, what it says. */}
                <View style={{ backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 20, padding: 18, gap: 10 }}>
                  <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                    <Tag kind={priorityTagKind(view.importance)} label={impLabel(view.importance, t)} testID="details-importance" />
                    <StatusChip view={view} label={statusLabel(view, t)} />
                    {category ? <Tag kind="muted" label={strings[CATEGORY_LABEL[category]]!} /> : null}
                  </View>
                  <View style={{ alignItems: 'flex-start' }}><Txt role="page" size={24} weight={700} testID="details-title">{view.title}</Txt></View>
                  {query.data?.description ? (
                    <Txt size={15} color={p.mu} lh={1.5} testID="details-description">{query.data.description}</Txt>
                  ) : null}
                  {open ? <StartIfProposed commitmentId={view.id} /> : null}
                </View>

                <View style={{ backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 20, paddingVertical: 4, paddingHorizontal: 14 }}>
                  {/* Where the saved week put it, first; its own day and time,
                      which Edit changes, below it (FX1). */}
                  {planned ? (
                    <Row icon="calendar" label={t.plannedRowLabel} testID="details-planned">
                      {`${formatRelativeDay(new Date(planned), { locale: lang, timeZone: timezone })} · ${ltr(formatTime(new Date(planned), { locale: lang, timeZone: timezone }))}`}
                    </Row>
                  ) : null}
                  <Row icon="today" label={t.dayLabel} testID="details-day">
                    {view.shownAt ? formatRelativeDay(new Date(view.shownAt), { locale: lang, timeZone: timezone }) : t.noTimeYet}
                  </Row>
                  <Row icon="clock" label={t.timeLabel} testID="details-time" latin>
                    {clockOf(view, { locale: lang, timeZone: timezone }) ?? t.noTimeYet}
                  </Row>
                  {view.postponedUntil ? <Row icon="clock" label={t.postponeReturn} testID="details-postponed-until">
                    {`${formatRelativeDay(new Date(view.postponedUntil), { locale: lang, timeZone: timezone })} · ${ltr(formatTime(new Date(view.postponedUntil), { locale: lang, timeZone: timezone }))}`}
                  </Row> : null}
                  <Row icon="flag" label={t.detailsImportanceLabel} testID="details-importance-row" ink={view.importance === 'must' ? p.acd : view.importance === 'should' ? p.wm : p.success}>
                    {impLabel(view.importance, t)}
                  </Row>
                  {/* A reminder only when it is its own instant: one at the due
                      time is the due time, already said above. */}
                  {reminderAt ? <Row icon="bell" label={t.detailsReminderLabel} testID="details-reminder">
                    {`${formatRelativeDay(new Date(reminderAt), { locale: lang, timeZone: timezone })} · ${ltr(formatTime(new Date(reminderAt), { locale: lang, timeZone: timezone }))}`}
                  </Row> : null}
                  {/* Shown whether or not there is one (#415): the ones the
                      model could not read are the ones worth correcting. */}
                  <CategoryRow
                    category={category}
                    enabled={preferences.data?.categoryPreferences.enabled ?? []}
                    onPick={filePicked}
                    disabled={patch.isPending}
                    canEdit={safeCommitmentPatchEnabled() && open}
                  />
                </View>

                {/* What else is happening then (UC-3.2, #186), as a note. */}
                <BusyConflictChip blocks={view.shownAt && !view.allDay ? busyAt(view.shownAt, busy) : []} testID="details-busy" />

                {prepTarget ? (
                  <View style={{ alignItems: 'flex-start' }}>
                    <Pill testID="details-prepare" label={t.xPrepare} kind="outline" onPress={() => actions.openMeetingPrep(prepTarget)} radius={20} pad={12} size={15} />
                  </View>
                ) : null}

                {/* "Remind me when I arrive / leave" (closure CL4). */}
                {query.data ? (
                  <PlaceReminderSection
                    commitment={query.data}
                    canEdit={safeCommitmentPatchEnabled() && open}
                    onLayout={(event) => { placeY.current = event.nativeEvent.layout.y; }}
                    onFormOpen={revealPlaceForm}
                  />
                ) : null}

                {!open ? <Txt size={13} color={p.mu} testID="details-closed-note">{t.detailsClosedNote}</Txt> : null}

                {/* «ما عاد بدّك ياها؟»: two different answers, said differently.
                    A drop keeps it in the history; a deletion does not. Each is
                    asked again in its own sheet before anything happens. */}
                <View style={{ backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 20, padding: 14, gap: 8 }} testID="details-let-go">
                  {open ? <Txt size={15} weight={600} style={{ paddingHorizontal: 4 }}>{t.detailsLetGoTitle}</Txt> : null}
                  {open ? (
                    <LetGoRow testID="details-drop" icon="archive" label={t.dropIt} sub={t.detailsDropSub} onPress={actions.openConfirmDrop} disabled={act.isPending} />
                  ) : null}
                  <LetGoRow testID="details-delete" icon="trash" label={t.detailsDelete} sub={t.detailsDeleteSub} onPress={actions.openConfirmDelete} />
                </View>

                {history.length > 0 ? (
                  <View style={{ gap: 6 }}>
                    <SectionLabel>{t.detailsHistory}</SectionLabel>
                    <Card pad={0} style={{ paddingVertical: 4, paddingHorizontal: 16, backgroundColor: p.sf }} testID="details-history">
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
  if (view.postponedUntil) return t.statusPostponed;
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

function Row({ icon, label, children, testID, latin, ink }: { icon: string; label: string; children: React.ReactNode; testID: string; latin?: boolean; ink?: string }) {
  const { p } = useApp();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, minHeight: 56, borderBottomWidth: 1, borderBottomColor: p.ln }}>
      <View accessible={false} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center' }}>
        <ReferenceIcon name={icon} size={19} color={ink ?? p.mu} />
      </View>
      <View style={{ flex: 1, gap: 1, alignItems: 'flex-start' }}>
        <Txt size={13} color={p.mu}>{label}</Txt>
        <Txt size={15} weight={ink ? 600 : 400} color={ink ?? p.tx} testID={testID} latin={latin}>{children}</Txt>
      </View>
    </View>
  );
}

/** Its state as a chip with a dot: open green, finished and dropped muted. */
function StatusChip({ view, label }: { view: CommitmentView; label: string }) {
  const { p } = useApp();
  const live = view.status === 'active';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, backgroundColor: live ? p.successSoft : p.sf2 }}>
      <View accessible={false} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: live ? p.success : p.mu }} />
      <Txt size={13} weight={600} color={live ? p.success : p.mu} testID="details-status">{label}</Txt>
    </View>
  );
}

/** One way to let it go: an icon, the verb, and what it means for the history. */
function LetGoRow({ testID, icon, label, sub, onPress, disabled }: { testID: string; icon: string; label: string; sub: string; onPress: () => void; disabled?: boolean }) {
  const { p } = useApp();
  return (
    <Btn testID={testID} label={`${label}. ${sub}`} onPress={onPress} disabled={disabled} scaleTo={0.99}
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 12, minHeight: 56, borderRadius: 16, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf2 }}>
      <View accessible={false} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: p.sf, alignItems: 'center', justifyContent: 'center' }}>
        <ReferenceIcon name={icon} size={18} color={disabled ? p.disTx : icon === 'trash' ? p.wm : p.mu} />
      </View>
      <View style={{ flex: 1, gap: 2, alignItems: 'flex-start' }}>
        <Txt size={15} weight={600} color={disabled ? p.disTx : icon === 'trash' ? p.wm : p.tx}>{label}</Txt>
        <Txt size={13} color={disabled ? p.disTx : p.mu}>{sub}</Txt>
      </View>
    </Btn>
  );
}

/**
 * «بلّش فيها» here too, but only for the commitment that is the current next
 * step and only when the server offers `accept` for it. Starting is an answer
 * to a proposal (the next-step route), not a state a commitment has, so a
 * commitment that is not proposed has no start button rather than an invented
 * one. Started never means done: the note says we stay quiet until they say so.
 */
function StartIfProposed({ commitmentId }: { commitmentId: string }) {
  const { t, p } = useApp();
  const next = useNextStep();
  const decide = useNextStepDecision();
  const [startedFor, setStartedFor] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const recommendation = next.data?.recommendation;
  const proposed = next.data?.exposure?.allowed !== false
    && recommendation?.state === 'ready'
    && recommendation.primaryStep?.commitmentId === commitmentId
    && (recommendation.availableActions ?? []).includes('accept');
  if (!recommendation || !proposed) return null;
  if (startedFor === recommendation.proposalId) {
    return (
      <View testID="details-started" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: p.acs, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 }}>
        <ReferenceIcon name="play" size={16} color={p.acd} />
        <Txt size={14} weight={500} color={p.acd} style={{ flex: 1 }}>{t.nextStepStartedNote}</Txt>
      </View>
    );
  }
  return (
    <Btn
      testID="details-start"
      label={t.nextStepAccept}
      disabled={decide.isPending}
      onPress={() => {
        if (inFlight.current) return;
        inFlight.current = true;
        decide.mutate({ decision: 'accept', proposal: recommendation }, {
          onSuccess: () => setStartedFor(recommendation.proposalId),
          onSettled: () => { inFlight.current = false; },
        });
      }}
      style={{ minHeight: 48, borderRadius: 999, backgroundColor: decide.isPending ? p.dis : p.ac, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16 }}
    >
      <ReferenceIcon name="play" size={16} color={decide.isPending ? p.disTx : p.onAccent} />
      <Txt size={15} weight={600} color={decide.isPending ? p.disTx : p.onAccent}>{t.nextStepAccept}</Txt>
    </Btn>
  );
}
