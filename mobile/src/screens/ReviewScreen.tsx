import { useLayoutMode } from '../theme/textScale';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useCaptureFlow } from '../features/capture/CaptureProvider';
import { ClarifySheet } from '../features/capture/ClarifySheet';
import { EditProposalItemSheet } from '../features/capture/EditProposalItemSheet';
import { dayKeptWithoutTime } from '../features/capture/noTimeDay';
import { questionText } from '../features/capture/clarificationCopy';
import { useTimeZone } from '../i18n/timezone';
import { formatDayKey, formatRelativeDay, formatTime } from '../i18n/format';
import { fill, ltr, type Lang } from '../i18n/strings';
import { cardShadow } from '../theme/tokens';
import { Btn, Pill, Txt } from '../ui/primitives';
import { TaskHeader } from '../ui/taskHeader';
import { AvoidKeyboard } from '../ui/keyboard';
import { useAnnounceOnIos } from '../ui/announce';
import { Tag, TextLink, priorityTagKind } from '../ui/chrome';
import { CheckIcon } from '../ui/icons';
import { ScreenIn } from '../ui/motion';
import { instantForLocalDateTime } from '../features/capture/localInstant';
import { prepRingAfterEdit } from '../features/meetings/prepRing';
import { quietTimeZone, quietWindowOf, toEngineSettings } from '../features/reminders/reminderInputs';
import { useProfile, useReminderSettings } from '../api/queries';
import { SeedProposalSection } from '../features/seeds/SeedProposalSection';
import { BusyConflictChip } from '../features/calendar/BusyConflictChip';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import { useConflictBusyBlocks } from '../features/google/useGoogle';
import { busyAt } from '../features/calendar/conflicts';
import { confirmableItems, wantsDiscardConfirmation, weeklyChoice, weeklyLockedByEdit, type CaptureItemEdit, type MeetingReviewContext } from '../features/capture/captureMachine';
import { WeeklyChoice } from '../features/weeklyBlocks/WeeklyChoice';
import { weeklyA11yLabel } from '../features/weeklyBlocks/weeklyText';
import { postManualBusy } from '../api/endpoints/calendar';
import { mailboxShortfall } from '../features/google/mailboxShortfall';
import type { CaptureProposalItem } from '../api/schemas/capture';
import type { UserFacingKey } from '../api/ui/userFacingMessage';
import type { ShareProposal, ShareDocumentFacts } from '../api/schemas/share';
import type { DeviceBusyBlock } from '../features/calendar/busyBlocks';

/**
 * Review, on the server's actual proposal (UC-2.R2, #172).
 *
 * ── Nothing is saved until Confirm ───────────────────────────────
 *
 * `suggestionNote` is unconditional. The contract says a proposal cannot
 * persist — `CAPTURE_PERSISTENCE_POLICY.proposalCanPersist` is `false` — and
 * this line is that fact in words on the one screen where a user might
 * reasonably assume otherwise.
 *
 * ── Deselect, don't delete ───────────────────────────────────────
 *
 * The old screen had an × that removed a proposed card outright. Nothing had
 * been created, so there was nothing to remove: what the user means is "not
 * that one", and the confirm sends only the selected ids. Deselected items stay
 * visible, so the count can be checked before pressing a button that writes.
 *
 * Times are formatted in the device zone, which is the same zone the request
 * carried, so the hour shown here is the hour the server resolved.
 */
export function ReviewScreen({ onBackToChat }: { onBackToChat?: () => void } = {}) {
  const { t, tr, p, lang, actions } = useApp();
  const insets = useSafeAreaInsets();
  const scrollActions = useLayoutMode() === 'xl';
  const flow = useCaptureFlow();
  const { state } = flow;
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  // Why the last answer to a question did not land, by item, so the line sits
  // under the question it belongs to and leaves with it.
  const [clarifyError, setClarifyError] = useState<{ itemId: string; key: UserFacingKey } | null>(null);
  const strings = t as unknown as Record<string, string>;
  // The local cache, not a request (UC-3.2, #186). A chip that had to wait for
  // the network would appear after the user had already pressed Confirm.
  const busyBlocks = useConflictBusyBlocks(useBusyBlocks());
  const items = state.proposal?.items ?? [];
  const seeds = state.proposal?.seeds ?? [];
  const selectedCount = state.selected.length;
  const busy = state.status === 'confirming';

  const leave = () => {
    flow.close();
    setConfirmingDiscard(false);
    actions.closeCapture();
  };

  const requestCancel = () => {
    if (wantsDiscardConfirmation(state)) {
      setConfirmingDiscard(true);
    } else {
      leave();
    }
  };

  const confirmable = confirmableItems(state.proposal, state.edits);

  const timezone = useTimeZone();
  const share = (state.proposal as ShareProposal | null)?.share;
  const mailbox = state.source === 'share' ? mailboxShortfall(state.proposal as ShareProposal | null) : null;
  const isDocumentShare = Boolean(
    state.source === 'share' &&
    share &&
    (share.kind === 'pdf' ||
      share.kind === 'textFile' ||
      share.document !== undefined ||
      share.evidence?.some((e) => e.document !== undefined))
  );

  const evidenceByItemId = useMemo(() => {
    const map = new Map<string, ShareDocumentFacts>();
    if (!share?.evidence) return map;
    for (const ev of share.evidence) {
      if (ev.itemId && ev.document) {
        map.set(ev.itemId, ev.document);
      }
    }
    return map;
  }, [share]);

  const [addingLectures, setAddingLectures] = useState(false);
  const [lecturesAdded, setLecturesAdded] = useState(false);
  const [lecturesError, setLecturesError] = useState<string | null>(null);

  const handleAddLectures = async () => {
    if (!share?.document?.recurringSessions || !state.proposal) return;
    setAddingLectures(true);
    setLecturesError(null);
    try {
      await postManualBusy({
        proposalId: state.proposal.proposalId,
        sessions: share.document.recurringSessions,
        timezone,
      });
      setLecturesAdded(true);
    } catch {
      setLecturesError(t.syllabusLecturesFailed);
    } finally {
      setAddingLectures(false);
    }
  };

  const KIND_ORDER = ['assignment', 'exam', 'quiz', 'presentation', 'deadline', 'other'] as const;

  const sectionTitles: Record<string, string> = {
    assignment: t.syllabusSectionAssignment,
    exam: t.syllabusSectionExam,
    quiz: t.syllabusSectionQuiz,
    presentation: t.syllabusSectionPresentation,
    deadline: t.syllabusSectionDeadline,
    other: t.syllabusSectionOther,
  };

  const groupedSections = useMemo(() => {
    if (!isDocumentShare) return null;
    const groups = new Map<string, CaptureProposalItem[]>();
    for (const kind of KIND_ORDER) {
      groups.set(kind, []);
    }
    for (const item of items) {
      const facts = evidenceByItemId.get(item.itemId);
      const kind = facts?.kind && (KIND_ORDER as readonly string[]).includes(facts.kind) ? facts.kind : 'other';
      const list = groups.get(kind);
      if (list) list.push(item);
    }
    for (const kind of KIND_ORDER) {
      const list = groups.get(kind);
      if (list) {
        list.sort((a, b) => {
          const factsA = evidenceByItemId.get(a.itemId);
          const factsB = evidenceByItemId.get(b.itemId);
          const timeA = factsA?.dueAt || a.resolvedTime || '';
          const timeB = factsB?.dueAt || b.resolvedTime || '';
          return timeA.localeCompare(timeB);
        });
      }
    }
    return KIND_ORDER.map((kind) => ({
      kind,
      title: sectionTitles[kind] || t.syllabusSectionOther,
      items: groups.get(kind) ?? [],
    })).filter((section) => section.items.length > 0);
  }, [isDocumentShare, items, evidenceByItemId, t]);

  /**
   * The items still waiting on their one question (UC-2.5, #165).
   *
   * Asked one at a time. A question this build has no words for is not counted:
   * the item keeps its flag and #164's edit sheet is the way to fix it, which
   * can express anything a fixed question cannot.
   */
  const unclarified = items.filter((item) => item.needsClarification && !confirmable.includes(item.itemId));
  const waiting = unclarified.filter((item) => (
    item.clarification
    && !skipped.includes(item.itemId)
    && questionText(item.clarification.questionKey, item.clarification.params, strings) !== null
  ));
  const asking = waiting[0];

  const answer = (itemId: string, value: { optionId?: string; freeText?: string }) => {
    setAnswering(true);
    setClarifyError(null);
    void flow.clarify(itemId, value).then((outcome) => {
      // A failure leaves the question up, and says so. Clearing it would look
      // like the answer landed; leaving it silently looked like nothing happened.
      setAnswering(false);
      if (!outcome.ok) setClarifyError({ itemId, key: outcome.messageKey });
    });
  };

  const handleEditChange = (itemId: string, next: CaptureItemEdit) => {
    const item = items.find((candidate) => candidate.itemId === itemId);
    const noTimeOption = item?.needsClarification
      ? item.clarification?.options.find((option) => !option.value.localTime && !option.value.localDate)
      : undefined;

    if (noTimeOption && next.localDateTime === '') {
      void answer(itemId, { optionId: noTimeOption.optionId });
      const otherEdits: CaptureItemEdit = {};
      if (next.title !== undefined && next.title !== item?.title) otherEdits.title = next.title;
      if (next.priority !== undefined && next.priority !== (item?.priority ?? 'normal')) {
        otherEdits.priority = next.priority;
      }
      if (Object.keys(otherEdits).length > 0) flow.editItem(itemId, otherEdits);
      return;
    }
    flow.editItem(itemId, next);
  };

  const confirmationActions = (
    <View style={{ paddingTop: 12, paddingHorizontal: scrollActions ? 0 : 16, paddingBottom: insets.bottom + 8, gap: 4, backgroundColor: p.bg, borderTopWidth: 1, borderTopColor: p.ln }}>
      {items.length > 0 ? (
        <>
          {selectedCount === 0 ? (
            <Txt size={12} color={p.mu} align="center" testID="review-none-selected">{t.reviewNothingSelected}</Txt>
          ) : null}
          <Pill
            testID="review-confirm"
            label={tr('confirmN', { n: selectedCount })}
            onPress={() => void flow.confirm()}
            disabled={selectedCount === 0 || busy}
            size={17}
            pad={14}
          />
        </>
      ) : null}
      <Pill
        testID="review-cancel"
        label={t.cancelAll}
        onPress={requestCancel}
        kind="ghost"
        size={14}
        weight={400}
        pad={10}
      />
    </View>

  );

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <TaskHeader
        pill={t.back}
        onPill={confirmingDiscard ? () => setConfirmingDiscard(false) : onBackToChat ?? (() => flow.backToComposer())}
        title={!asking && scrollActions ? t.reviewConfirmationHeading : t.reviewTitle}
        pillTestID="review-back"
      />
      {confirmingDiscard ? (
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 20, gap: 14 }} testID="capture-discard">
          <Txt role="section">{t.captureDiscardTitle}</Txt>
          <Txt role="body" color={p.mu}>{t.captureDiscardBody}</Txt>
          <Pill testID="capture-discard-keep" label={t.captureKeepEditing} onPress={() => setConfirmingDiscard(false)} />
          <Pill testID="capture-discard-confirm" label={t.captureDiscardConfirm} onPress={leave} kind="warm" />
        </View>
      ) : (
        <AvoidKeyboard testID="review-kav" style={{ flex: 1 }}>
      <ScrollView
        testID="review-scroll"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 20, gap: 12 }}
      >
        {state.source === 'meeting' ? (
          <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: p.sf, borderRadius: 20, paddingVertical: 10, paddingHorizontal: 14 }, cardShadow(p)]} testID="review-source-meeting">
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.wm }} />
            <View style={{ flex: 1, gap: 2, alignItems: 'flex-start' }}>
              <Txt size={13} color={p.mu}>{state.meeting?.appointment ? t.reviewSourceAppointment : t.reviewSourceMeeting}</Txt>
              {/* The prep step's reminder, always (UAT round 2, N7): when it
                  rings, why it moved (quiet hours, short notice — CL5a M-8,
                  I-3), or why nothing rings; after an edit, the phone's own
                  answer for the step as it will be confirmed, and a line when
                  the new time is not before the meeting (N5). */}
              {state.meeting ? (
                <PrepReminderLine
                  meeting={state.meeting}
                  proposed={state.proposal?.items.find((item) => item.itemId === state.meeting?.itemId) ?? null}
                  edit={state.meeting.itemId ? state.edits[state.meeting.itemId] : undefined}
                />
              ) : null}
            </View>
          </View>
        ) : null}
        {state.source === 'share' ? (
          <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: p.sf, borderRadius: 20, paddingVertical: 10, paddingHorizontal: 14 }, cardShadow(p)]} testID="review-source">
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.wm }} />
            <Txt size={13} color={p.mu} style={{ flex: 1 }}>{t.reviewSourceShare}</Txt>
            <Txt size={12} color={p.wm}>{t.reviewUntrusted}</Txt>
          </View>
        ) : null}
        {/* A Gmail scan stopped part-way (CL6a review I2): what is below came
            from some of the mail, and the rest was not read. "Try again" only
            when a retry could read it (round 2, N2). */}
        {mailbox ? (
          <Txt role="supporting" color={p.wm} style={{ paddingHorizontal: 4 }} testID="review-mailbox-partial">
            {fill(mailbox.retryHelps ? t.googleGmailPartial : t.googleGmailPartialNewest, { read: mailbox.read, total: mailbox.total })}
          </Txt>
        ) : null}
        {/* The dashed dot is the proposal mark, the same one the cards carry:
            the sentence and the shape say one thing. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderStyle: 'dashed', borderColor: p.prop }} />
          <Txt role="supporting" color={p.mu} style={{ flex: 1 }} testID="review-note">{t.suggestionNote}</Txt>
        </View>

        {asking ? (
          <View style={{ backgroundColor: p.sf, borderRadius: 20, padding: 18 }}>
            <ClarifySheet
              key={asking.itemId}
              item={asking}
              position={unclarified.length - waiting.length + 1}
              total={unclarified.length}
              busy={answering}
              error={clarifyError?.itemId === asking.itemId ? t[clarifyError.key] : null}
              onAnswer={(value) => answer(asking.itemId, value)}
              onSkip={() => {
                // "Leave it without a time" is an answer (#474). When the
                // server offers "no specific time" — the option with no value —
                // it is sent as that answer, so the item is settled as a
                // time-less commitment and can be saved. Hiding the question
                // locally left the item flagged, unselectable and unsavable.
                const noTime = asking.clarification?.options.find(
                  (option) => !option.value.localTime && !option.value.localDate,
                );
                if (noTime) {
                  answer(asking.itemId, { optionId: noTime.optionId });
                  return;
                }
                // A question with no time-less answer (which day, am or pm,
                // what to do) is only dismissed; #164's edit sheet fixes it.
                setSkipped((current) => [...current, asking.itemId]);
              }}
            />
          </View>
        ) : null}

        {state.status === 'confirmFailed' ? (
          <View style={{ backgroundColor: p.wms, borderRadius: 20, padding: 14 }} testID="review-confirm-failed">
            <Txt size={14} color={p.wm}>{t[state.messageKey ?? 'errorsGeneric']}</Txt>
          </View>
        ) : null}

        {isDocumentShare ? (
          <View style={{ gap: 8, paddingHorizontal: 4, paddingVertical: 4 }} testID="review-document-header">
            {share?.document?.documentTitle || share?.document?.courseName ? (
              <Txt role="section" size={17} weight={700}>
                {fill(t.syllabusDatesFoundWithTitle, {
                  title: share.document.documentTitle || share.document.courseName || '',
                  n: items.length,
                })}
              </Txt>
            ) : (
              <Txt role="section" size={17} weight={700}>
                {fill(t.syllabusDatesFound, { n: items.length })}
              </Txt>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
              <TextLink
                testID="review-select-all"
                label={t.syllabusSelectAll}
                onPress={() => flow.selectAll()}
                size={14}
              />
              <TextLink
                testID="review-select-none"
                label={t.syllabusSelectNone}
                onPress={() => flow.deselectAll()}
                size={14}
              />
            </View>
          </View>
        ) : null}

        {isDocumentShare && share?.document?.recurringSessions && share.document.recurringSessions.length > 0 ? (
          <View
            style={[
              {
                backgroundColor: p.sf,
                borderRadius: 20,
                padding: 16,
                gap: 10,
                borderWidth: 1,
                borderColor: p.ln,
              },
              cardShadow(p),
            ]}
            testID="review-lecture-times-banner"
          >
            {lecturesAdded ? (
              <View
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
                testID="review-lecture-times-added"
              >
                <CheckIcon size={18} color={p.ac} />
                <Txt size={14} weight={600} color={p.tx}>
                  {t.syllabusLecturesAdded}
                </Txt>
              </View>
            ) : (
              <View style={{ gap: 8 }} testID="review-lecture-times-prompt">
                <Txt size={14} weight={600} color={p.tx}>
                  {t.syllabusAddLecturesPrompt}
                </Txt>
                {lecturesError ? (
                  <Txt size={12} color={p.wm}>
                    {lecturesError}
                  </Txt>
                ) : null}
                <Pill
                  testID="review-add-lecture-times"
                  label={t.syllabusAddLecturesAction}
                  onPress={() => void handleAddLectures()}
                  disabled={addingLectures}
                  kind="soft"
                  size={14}
                />
              </View>
            )}
          </View>
        ) : null}

        {!isDocumentShare && !asking && !scrollActions ? (
          <View style={{ gap: 4, paddingHorizontal: 4, paddingVertical: 8 }} testID="review-confirmation-heading">
            <Txt role="section">{t.reviewConfirmationHeading}</Txt>
            <Txt role="supporting" color={p.mu}>{t.reviewConfirmationBody}</Txt>
          </View>
        ) : null}

        {groupedSections ? (
          groupedSections.map((section) => (
            <View key={section.kind} style={{ gap: 8, marginTop: 8 }} testID={`review-section-${section.kind}`}>
              <Txt role="section" size={15} weight={700} color={p.tx} style={{ paddingHorizontal: 4 }}>
                {section.title} ({section.items.length})
              </Txt>
              {section.items.map((item) => (
                <ItemCard
                  key={item.itemId}
                  item={item}
                  edit={state.edits[item.itemId]}
                  selected={state.selected.includes(item.itemId)}
                  needsQuestion={item.needsClarification && !confirmable.includes(item.itemId)}
                  onToggle={() => flow.toggleItem(item.itemId)}
                  onEdit={() => setEditingItemId(item.itemId)}
                  weekly={weeklyChoice(state, item.itemId)}
                  weeklyLocked={weeklyLockedByEdit(state, item.itemId)}
                  onWeekly={(weekly) => flow.setWeekly(item.itemId, weekly)}
                  lang={lang}
                  busy={busyBlocks}
                  docFacts={evidenceByItemId.get(item.itemId)}
                />
              ))}
            </View>
          ))
        ) : (
          items.map((item) => (
            <ItemCard
              key={item.itemId}
              item={item}
              edit={state.edits[item.itemId]}
              selected={state.selected.includes(item.itemId)}
              needsQuestion={item.needsClarification && !confirmable.includes(item.itemId)}
              onToggle={() => flow.toggleItem(item.itemId)}
              onEdit={() => setEditingItemId(item.itemId)}
              weekly={weeklyChoice(state, item.itemId)}
              weeklyLocked={weeklyLockedByEdit(state, item.itemId)}
              onWeekly={(weekly) => flow.setWeekly(item.itemId, weekly)}
              lang={lang}
              busy={busyBlocks}
              docFacts={evidenceByItemId.get(item.itemId)}
            />
          ))
        )}

        {state.proposal && seeds.length > 0 ? (
          <SeedProposalSection proposalId={state.proposal.proposalId} seeds={seeds} />
        ) : null}

        {/* Held, and applied atomically at confirm (#164). Nothing is written
            while this is open. */}
        {editingItemId ? (
          <View style={{ backgroundColor: p.sf, borderRadius: 20, padding: 18 }}>
            <EditProposalItemSheet
              item={items.find((item) => item.itemId === editingItemId)!}
              edit={state.edits[editingItemId]}
              onChange={(next) => handleEditChange(editingItemId, next)}
              onClose={() => setEditingItemId(null)}
            />
          </View>
        ) : null}
        {scrollActions ? confirmationActions : null}
      </ScrollView>

      {!scrollActions ? confirmationActions : null}
        </AvoidKeyboard>
      )}
    </ScreenIn>
  );
}

const PRIORITY_IMP = { high: 'must', normal: 'should', low: 'nice' } as const;

function ItemCard({
  item, edit, selected, needsQuestion, onToggle, onEdit, weekly = null, weeklyLocked = false, onWeekly, lang, busy, docFacts,
}: {
  item: CaptureProposalItem;
  edit: CaptureItemEdit | undefined;
  selected: boolean;
  needsQuestion: boolean;
  onToggle: () => void;
  onEdit: () => void;
  /** «كل أسبوع» / «مرة وحدة بس» for an item the server offered a weekly block for; null otherwise. */
  weekly?: 'weekly' | 'once' | null;
  weeklyLocked?: boolean;
  onWeekly?: (weekly: boolean) => void;
  lang: Lang;
  busy: readonly DeviceBusyBlock[];
  docFacts?: ShareDocumentFacts | undefined;
}) {
  const { t, p, tr } = useApp();
  const timezone = useTimeZone();
  // What the card shows is what will be confirmed: the edit if there is one,
  // the proposal otherwise. Showing the original under a card the user has
  // changed is how they confirm something they did not mean.
  const title = edit?.title ?? item.title;
  const editedInstant = edit?.localDateTime !== undefined
    ? (edit.localDateTime === '' ? null : instantForLocalDateTime(edit.localDateTime, timezone))
    : (item.resolvedTime ? new Date(item.resolvedTime) : null);
  // A day still waiting on its hour is shown with its date (L4). It used to read
  // only "No time", so the Sunday the product had picked was invisible — and a
  // weekday alone could not say whether it meant this Sunday or next.
  const pendingDay = !editedInstant && edit?.localDateTime === undefined && item.needsClarification
    ? item.resolvedDate
    : undefined;
  // A deadline with a day and no hour — «قبل آخر الشهر» (FX3): settled, so
  // nothing is asked, and it confirms as an all-day `due_by`. It used to read
  // only «بدون وقت», and the day the person said was nowhere on the card.
  const dueByDay = !editedInstant && edit?.localDateTime === undefined && !item.needsClarification
    ? item.resolvedDate
    : undefined;
  // An appointment answered "no specific time" (FY1 N4) is *on* its day, not
  // due by it: «الأحد · بدون وقت», never «لحد الأحد». So is one whose hour was
  // cleared in the edit sheet: the confirm keeps it there (N11).
  const onDay = pendingDay ?? (item.allDayEvent ? dueByDay : undefined) ?? dayKeptWithoutTime(item, edit);
  const when = editedInstant
    ? `${formatRelativeDay(editedInstant, { locale: lang, timeZone: timezone })} · ${ltr(formatTime(editedInstant, { locale: lang, timeZone: timezone }))}`
    : onDay
      ? `${formatDayKey(onDay, { locale: lang, timeZone: timezone })} · ${t.noTimeYet}`
      : dueByDay
        ? tr('reviewDueByDay', { day: formatDayKey(dueByDay, { locale: lang, timeZone: timezone }) })
        : t.noTimeYet;
  // The day is our guess from a weekday name, and it is on screen. Gone once
  // the user sets the time themselves: then the day is theirs (#164's rule).
  const dateGuessed = Boolean(item.dateEstimated && item.resolvedDate && (editedInstant || pendingDay || dueByDay) && edit?.localDateTime === undefined);
  // The hour is ours: the person named only a part of the day — «المسا» —
  // and 18:00 is what we made of it (UAT round 6, D2). Marked while that hour
  // is the one on screen; gone once they set the time themselves.
  const timeGuessed = Boolean(item.timeEstimated && item.resolvedTime && editedInstant && edit?.localDateTime === undefined);
  const priority = edit?.priority ?? item.priority;

  // Kept weekly, the card is the block — «كل سبت · 10:00–16:00» — not the one
  // Saturday the one-off would have been; the date chip and its guess marks
  // describe that one-off and step aside.
  const offer = item.weeklyBlock;
  const asWeekly = weekly === 'weekly' && offer !== undefined;
  const whenSpoken = asWeekly ? weeklyA11yLabel({ ...offer, title }, lang, { withTitle: false }) : when;

  const imp = priority ? PRIORITY_IMP[priority] : null;
  const impLabel = imp === 'must' ? t.todayGroupMust : imp === 'should' ? t.todayGroupShould : imp === 'nice' ? t.todayGroupNice : null;
  return (
    // The dashed card is this View, not the checkbox: the weekly choice sits
    // inside the card but outside the checkbox, because a Pressable is one
    // element to VoiceOver and TalkBack, and two radios inside it could not be
    // reached at all.
    <View
      testID={`review-card-${item.itemId}`}
      style={{
        // Dashed all round in the proposal colour: nothing has been written.
        // Selection belongs to the explicit checkbox, not the proposal border.
        backgroundColor: p.sf, borderRadius: 20, overflow: 'hidden',
        borderWidth: 1.5, borderStyle: 'dashed', borderColor: p.prop,
      }}
    >
      <Btn
        testID={`review-item-${item.itemId}`}
        onPress={onToggle}
        scaleTo={0.99}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        label={`${title}, ${selected ? t.reviewSelected : t.reviewNotSelected}, ${whenSpoken}${!asWeekly && dateGuessed ? `, ${t.reviewDateEstimated}` : ''}${!asWeekly && timeGuessed ? `, ${t.reviewTimeEstimated}` : ''}`}
        style={{ paddingVertical: 16, paddingHorizontal: 18, gap: 10, alignItems: 'flex-start' }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, alignSelf: 'stretch' }}>
          <View
            testID={`review-check-${item.itemId}`}
            style={{
              width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginTop: 2,
              backgroundColor: selected ? p.acs : 'transparent',
              borderWidth: 2, borderColor: selected ? p.acd : p.lnStrong,
            }}
          >
            {selected ? <CheckIcon size={16} color={p.acd} /> : null}
          </View>
          <Txt role="card" style={{ flex: 1 }}>{title}</Txt>
          <TextLink testID={`review-edit-${item.itemId}`} label={t.reviewEdit} onPress={onEdit} size={13} />
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {asWeekly ? null : (
            <View style={{ backgroundColor: item.needsClarification ? p.wms : p.sf2, borderRadius: 8, paddingVertical: 5, paddingHorizontal: 10 }}>
              <Txt size={12} weight={item.needsClarification ? 600 : 400} color={item.needsClarification ? p.wm : p.tx} testID={`review-when-${item.itemId}`}>{when}</Txt>
            </View>
          )}
          {/* Same dashed mark as the priority guess below, naming what was
              guessed. A tap opens the edit sheet, which offers the same weekday a
              week later in one tap (L4). */}
          {dateGuessed && !asWeekly ? (
            <Btn
              testID={`review-date-estimated-${item.itemId}`}
              label={t.reviewDateEstimated}
              hint={t.reviewEdit}
              onPress={onEdit}
              hitSlop={12}
              scaleTo={0.97}
              style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: p.lnStrong, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 8 }}
            >
              <Txt size={12} color={p.mu}>{t.reviewDateEstimated}</Txt>
            </Btn>
          ) : null}
          {/* The same mark for a guessed hour; a tap opens the edit sheet, where
              the time they set is theirs (D2). Both marks can show at once. */}
          {timeGuessed && !asWeekly ? (
            <Btn
              testID={`review-time-estimated-${item.itemId}`}
              label={t.reviewTimeEstimated}
              hint={t.reviewEdit}
              onPress={onEdit}
              hitSlop={12}
              scaleTo={0.97}
              style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: p.lnStrong, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 8 }}
            >
              <Txt size={12} color={p.mu} testID={`review-time-estimated-${item.itemId}-text`}>{t.reviewTimeEstimated}</Txt>
            </Btn>
          ) : null}
          {imp && impLabel && imp !== 'nice' ? <Tag kind={priorityTagKind(imp)} label={impLabel} /> : null}
          {/* A guess named as one — and no longer a guess once the user has set
              it themselves. A level presented as a fact they stated is how a
              product loses the right to guess at all (#164). */}
          {item.priorityEstimated && edit?.priority === undefined ? (
            <View style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: p.lnStrong, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 8 }}>
              <Txt size={12} color={p.mu} testID={`review-estimated-${item.itemId}`}>{t.reviewEstimated}</Txt>
            </View>
          ) : null}
          {docFacts?.page ? (
            <View style={{ backgroundColor: p.sf2, borderRadius: 8, paddingVertical: 3, paddingHorizontal: 8 }} testID={`review-page-${item.itemId}`}>
              <Txt size={12} color={p.mu}>{fill(t.syllabusPageChip, { page: docFacts.page })}</Txt>
            </View>
          ) : null}
          {needsQuestion ? (
            <Txt size={12} color={p.wm} testID={`review-needs-question-${item.itemId}`}>{t.reviewNeedsQuestion}</Txt>
          ) : null}
          {/* Checked against the time the card *shows*, which is the edited one
              when there is an edit: a chip about the time the server proposed
              would be a note about something the user has already changed. It
              never blocks Confirm — see `BusyConflictChip`. */}
          <BusyConflictChip
            blocks={editedInstant && !asWeekly ? busyAt(editedInstant.toISOString(), busy) : []}
            testID={`review-busy-${item.itemId}`}
          />
        </View>
      </Btn>
      {offer && weekly && onWeekly ? (
        <View style={{ paddingHorizontal: 18, paddingBottom: 16 }}>
          <WeeklyChoice itemId={item.itemId} offer={offer} title={edit?.title ?? offer.title} choice={weekly} locked={weeklyLocked} onChoose={onWeekly} />
        </View>
      ) : null}
    </View>
  );
}

/** setTimeout's ceiling (about 24.8 days); a later ring is rechecked when the screen is next opened. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * One line about the prep step's reminder: when it will ring, or why nothing
 * will — always, the ordinary case too (UAT round 2, N7: a Review that said
 * nothing for the initial 14:00 or an edit to 13:00 never told the person
 * when). After the person changes the step's time or makes it a Must, the
 * prepare response no longer describes it: the line is answered again for the
 * step as it will be confirmed (`EditedPrepLine`, FX1).
 */
function PrepReminderLine({ meeting, proposed, edit }: {
  meeting: MeetingReviewContext;
  proposed: CaptureProposalItem | null;
  edit: CaptureItemEdit | undefined;
}) {
  const { t, p } = useApp();
  const timezone = useTimeZone();
  const editedAt = edit?.localDateTime === undefined
    ? undefined
    : edit.localDateTime === '' ? null : (instantForLocalDateTime(edit.localDateTime, timezone)?.toISOString() ?? null);
  const timeChanged = editedAt !== undefined
    && (editedAt === null ? proposed?.resolvedTime != null : Date.parse(editedAt) !== Date.parse(proposed?.resolvedTime ?? ''));
  const priorityChanged = edit?.priority !== undefined && edit.priority !== (proposed?.priority ?? 'normal');
  const edited = Boolean(meeting.startAt && proposed && (timeChanged || priorityChanged));
  // Once an edit has been shown, the proposed line coming back is news too
  // (an edit taken back): it is announced when it returns (review m3).
  const [everEdited, setEverEdited] = useState(false);
  if (edited && !everEdited) setEverEdited(true);
  // One live region around whichever line shows, so TalkBack hears the line
  // change after an edit (FY3 review m4); VoiceOver is told by each line.
  return (
    <View testID="review-prep-live" accessibilityLiveRegion="polite" style={{ gap: 2, alignItems: 'flex-start' }}>
      {edited && meeting.startAt && proposed ? (
        <EditedPrepLine
          at={editedAt === undefined ? proposed.resolvedTime ?? null : editedAt}
          meetingStart={meeting.startAt}
          priority={edit?.priority ?? proposed.priority ?? 'normal'}
          appointment={meeting.appointment === true}
        />
      ) : <ProposedPrepLine meeting={meeting} announceOnMount={everEdited} />}
      {/* Why then (audit 2026-10-03 #3): the day before, at the first free hour. */}
      {!edited && meeting.timing === 'day_before' ? (
        <Txt size={13} color={p.mu} testID="review-prep-why">
          {(meeting.sessions ?? 1) > 1 ? t.reviewPrepWhyDayBeforeWithReview : t.reviewPrepWhyDayBefore}
        </Txt>
      ) : null}
    </View>
  );
}

const REMINDER_PRIORITY = { high: 'must', normal: 'should', low: 'nice' } as const;

/**
 * The line for an edited prep step: what the phone will ring for it, from its
 * own planning and the account's settings (`prepRingAfterEdit`). Nothing is
 * said about the ring until the settings are read — a line about them before
 * then would be a guess.
 *
 * A step moved to the meeting's start or later is no longer a window: it is
 * reminded a lead before its own time, like any step, so the ring can read
 * earlier than the card (17:00 on the card, 16:00 in the line). One more line
 * says it is no longer before the meeting, so neither is a surprise (N5).
 */
function EditedPrepLine({ at, meetingStart, priority, appointment }: {
  at: string | null;
  meetingStart: string;
  priority: 'high' | 'normal' | 'low';
  appointment: boolean;
}) {
  const { t, p, lang } = useApp();
  const timezone = useTimeZone();
  const settings = useReminderSettings();
  const profile = useProfile();
  const dto = settings.data?.reminderSettings;
  // The same rule the server's edit applies (`windowEndAfterMove`): strictly
  // before the start stays the prep window; at or after it does not.
  const notBeforeText = at !== null && Date.parse(at) >= Date.parse(meetingStart)
    ? (appointment ? t.reviewPrepAfterAppointment : t.reviewPrepAfterMeeting)
    : null;
  const answer = !dto || profile.data === undefined ? null : prepRingAfterEdit({
    at,
    meetingStart,
    priority: REMINDER_PRIORITY[priority],
    settings: toEngineSettings(dto, profile.data.routine?.preferredReminderIntensity ?? 'softAwareness'),
    quietHours: quietWindowOf(dto),
    timeZone: quietTimeZone(dto),
    now: new Date(),
  });
  const ringText = answer === null ? null
    : answer.kind === 'rings' ? ringsAtText(answer.at, t.reviewPrepRingsAt, lang, timezone)
      : answer.because === 'no_time' ? t.reviewPrepNoTime
        : answer.because === 'reminders_off' ? t.reviewPrepRemindersOff
          : answer.because === 'silent_choice' ? t.reviewPrepSilentChoice
            : answer.because === 'quiet_hours' ? t.reviewPrepQuietHours
              : t.reviewPrepTooClose;
  // This line exists only because the person edited the step, so each new
  // answer is news: said to VoiceOver as it lands (FY3 review m4) — once the
  // settings have answered, so a cold cache does not say the first half and
  // then all of it again (review m2). If they cannot be read, what is known.
  const settled = answer !== null || settings.isError || profile.isError;
  useAnnounceOnIos(settled ? [notBeforeText, ringText].filter(Boolean).join(' ') || null : null);
  return (
    <>
      {notBeforeText ? <Txt size={13} color={p.mu} testID="review-prep-after-meeting">{notBeforeText}</Txt> : null}
      {answer === null || ringText === null ? null : (
        <Txt size={13} color={p.mu} testID={answer.kind === 'rings' ? 'review-prep-rings-at' : 'review-prep-no-reminder'}>{ringText}</Txt>
      )}
    </>
  );
}

/** «التذكير رح يرن: بكرا · 14:00» — said even when that is the time the card shows (N7). */
function ringsAtText(at: number | string, template: string, lang: Lang, timezone: string): string {
  const ring = new Date(at);
  const time = `${formatRelativeDay(ring, { locale: lang, timeZone: timezone })} · ${ltr(formatTime(ring, { locale: lang, timeZone: timezone }))}`;
  return fill(template, { time });
}

/**
 * The line the prepare response gives, for the step as the server proposed it.
 *
 * Said to VoiceOver when it changes while Review is open — the ring passing,
 * or an edit taken back (`announceOnMount`) — never as the line Review opens
 * with (review m3; TalkBack hears the same from the live region around it).
 */
function ProposedPrepLine({ meeting, announceOnMount }: { meeting: MeetingReviewContext; announceOnMount: boolean }) {
  const { t, p, lang } = useApp();
  const timezone = useTimeZone();
  // A ring whose moment passes while Review is open is one the phone skips
  // (n-2): from then on it is said as too close, not as a time that will not
  // come. A timer, so the line changes at that moment and render stays pure.
  // One already past when the line mounts is too close from the start.
  const ringMs = meeting.remindAt === null ? null : Date.parse(meeting.remindAt);
  const [passedRing, setPassedRing] = useState<number | null>(() => (ringMs !== null && ringMs <= Date.now() ? ringMs : null));
  useEffect(() => {
    if (ringMs === null) return undefined;
    const timer = setTimeout(() => setPassedRing(ringMs), Math.min(Math.max(0, ringMs - Date.now()), MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [ringMs]);
  const passed = ringMs !== null && passedRing === ringMs;
  let text: string;
  let testID: string;
  if (meeting.remindAt === null || passed) {
    const silence = passed ? 'too_close' : meeting.silentBecause;
    testID = 'review-prep-no-reminder';
    text = silence === 'reminders_off' ? t.reviewPrepRemindersOff
      : silence === 'silent_choice' ? t.reviewPrepSilentChoice
        : silence === 'quiet_hours' ? t.reviewPrepQuietHours
          : t.reviewPrepTooClose;
  } else if (meeting.adjustment === 'none') {
    // Rings at the time the card shows: still said (N7).
    testID = 'review-prep-rings-at';
    text = ringsAtText(meeting.remindAt, t.reviewPrepRingsAt, lang, timezone);
  } else {
    const at = new Date(meeting.remindAt);
    const time = `${formatRelativeDay(at, { locale: lang, timeZone: timezone })} · ${ltr(formatTime(at, { locale: lang, timeZone: timezone }))}`;
    const quiet = meeting.adjustment === 'quiet_hours';
    testID = quiet ? 'review-prep-quiet-moved' : 'review-prep-short-notice';
    text = fill(quiet ? t.reviewPrepQuietMoved : t.reviewPrepShortNotice, { time });
  }
  const [openedWith] = useState(text);
  useAnnounceOnIos(announceOnMount || text !== openedWith ? text : null);
  return <Txt size={13} color={p.mu} testID={testID}>{text}</Txt>;
}
