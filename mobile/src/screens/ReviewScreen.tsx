import { useLayoutMode } from '../theme/textScale';
import React, { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useCaptureFlow } from '../features/capture/CaptureProvider';
import { ClarifySheet } from '../features/capture/ClarifySheet';
import { EditProposalItemSheet } from '../features/capture/EditProposalItemSheet';
import { questionText } from '../features/capture/clarificationCopy';
import { useTimeZone } from '../i18n/timezone';
import { formatDayKey, formatRelativeDay, formatTime } from '../i18n/format';
import { fill, ltr, type Lang } from '../i18n/strings';
import { cardShadow } from '../theme/tokens';
import { Btn, Pill, Txt } from '../ui/primitives';
import { TaskHeader } from '../ui/taskHeader';
import { Tag, TextLink } from '../ui/chrome';
import { CheckIcon } from '../ui/icons';
import { ScreenIn } from '../ui/motion';
import { instantForLocalDateTime } from '../features/capture/localInstant';
import { SeedProposalSection } from '../features/seeds/SeedProposalSection';
import { BusyConflictChip } from '../features/calendar/BusyConflictChip';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import { busyAt } from '../features/calendar/conflicts';
import { confirmableItems, wantsDiscardConfirmation, type CaptureItemEdit } from '../features/capture/captureMachine';
import { postManualBusy } from '../api/endpoints/calendar';
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
export function ReviewScreen() {
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
  const busyBlocks = useBusyBlocks();
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
        onPill={confirmingDiscard ? () => setConfirmingDiscard(false) : () => flow.backToComposer()}
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
        <KeyboardAvoidingView
          testID="review-kav"
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
      <ScrollView
        testID="review-scroll"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 20, gap: 12 }}
      >
        {state.source === 'share' ? (
          <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: p.sf, borderRadius: 16, paddingVertical: 10, paddingHorizontal: 14 }, cardShadow(p)]} testID="review-source">
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.wm }} />
            <Txt size={13} color={p.mu} style={{ flex: 1 }}>{t.reviewSourceShare}</Txt>
            <Txt size={12} color={p.wm}>{t.reviewUntrusted}</Txt>
          </View>
        ) : null}
        {/* The dashed dot is the proposal mark, the same one the cards carry:
            the sentence and the shape say one thing. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderStyle: 'dashed', borderColor: p.prop }} />
          <Txt role="supporting" color={p.mu} style={{ flex: 1 }} testID="review-note">{t.suggestionNote}</Txt>
        </View>

        {asking ? (
          <View style={{ backgroundColor: p.sf, borderRadius: 24, padding: 18 }}>
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
          <View style={{ backgroundColor: p.wms, borderRadius: 18, padding: 14 }} testID="review-confirm-failed">
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
          <View style={{ backgroundColor: p.sf, borderRadius: 24, padding: 18 }}>
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
        </KeyboardAvoidingView>
      )}
    </ScreenIn>
  );
}

const PRIORITY_IMP = { high: 'must', normal: 'should', low: 'nice' } as const;

function ItemCard({
  item, edit, selected, needsQuestion, onToggle, onEdit, lang, busy, docFacts,
}: {
  item: CaptureProposalItem;
  edit: CaptureItemEdit | undefined;
  selected: boolean;
  needsQuestion: boolean;
  onToggle: () => void;
  onEdit: () => void;
  lang: Lang;
  busy: readonly DeviceBusyBlock[];
  docFacts?: ShareDocumentFacts | undefined;
}) {
  const { t, p } = useApp();
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
  const when = editedInstant
    ? `${formatRelativeDay(editedInstant, { locale: lang, timeZone: timezone })} · ${ltr(formatTime(editedInstant, { locale: lang, timeZone: timezone }))}`
    : pendingDay
      ? `${formatDayKey(pendingDay, { locale: lang, timeZone: timezone })} · ${t.noTimeYet}`
      : t.noTimeYet;
  // The day is our guess from a weekday name, and it is on screen. Gone once
  // the user sets the time themselves: then the day is theirs (#164's rule).
  const dateGuessed = Boolean(item.dateEstimated && item.resolvedDate && (editedInstant || pendingDay) && edit?.localDateTime === undefined);
  const priority = edit?.priority ?? item.priority;

  const imp = priority ? PRIORITY_IMP[priority] : null;
  const impLabel = imp === 'must' ? t.todayGroupMust : imp === 'should' ? t.todayGroupShould : imp === 'nice' ? t.todayGroupNice : null;
  return (
    <Btn
      testID={`review-item-${item.itemId}`}
      onPress={onToggle}
      scaleTo={0.99}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      label={`${title}, ${selected ? t.reviewSelected : t.reviewNotSelected}, ${when}${dateGuessed ? `, ${t.reviewDateEstimated}` : ''}`}
      style={{
        // Dashed all round in the proposal colour: nothing has been written.
        // Selection belongs to the explicit checkbox, not the proposal border.
        backgroundColor: p.sf, borderRadius: 24, paddingVertical: 16, paddingHorizontal: 18, gap: 10,
        alignItems: 'flex-start', overflow: 'hidden',
        borderWidth: 1.5, borderStyle: 'dashed', borderColor: p.prop,

      }}
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
        <View style={{ backgroundColor: item.needsClarification ? p.wms : p.sf2, borderRadius: 8, paddingVertical: 5, paddingHorizontal: 10 }}>
          <Txt size={12} weight={item.needsClarification ? 600 : 400} color={item.needsClarification ? p.wm : p.tx} testID={`review-when-${item.itemId}`}>{when}</Txt>
        </View>
        {/* Same dashed mark as the priority guess below, naming what was
            guessed. A tap opens the edit sheet, which offers the same weekday a
            week later in one tap (L4). */}
        {dateGuessed ? (
          <Btn
            testID={`review-date-estimated-${item.itemId}`}
            label={t.reviewDateEstimated}
            hint={t.reviewEdit}
            onPress={onEdit}
            hitSlop={12}
            scaleTo={0.97}
            style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: p.lnStrong, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 8 }}
          >
            <Txt size={11} color={p.mu}>{t.reviewDateEstimated}</Txt>
          </Btn>
        ) : null}
        {imp && impLabel && imp !== 'nice' ? <Tag kind={imp === 'must' ? 'must' : 'should'} label={impLabel} /> : null}
        {/* A guess named as one — and no longer a guess once the user has set
            it themselves. A level presented as a fact they stated is how a
            product loses the right to guess at all (#164). */}
        {item.priorityEstimated && edit?.priority === undefined ? (
          <View style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: p.lnStrong, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 8 }}>
            <Txt size={11} color={p.mu} testID={`review-estimated-${item.itemId}`}>{t.reviewEstimated}</Txt>
          </View>
        ) : null}
        {docFacts?.page ? (
          <View style={{ backgroundColor: p.sf2, borderRadius: 8, paddingVertical: 3, paddingHorizontal: 8 }} testID={`review-page-${item.itemId}`}>
            <Txt size={11} color={p.mu}>{fill(t.syllabusPageChip, { page: docFacts.page })}</Txt>
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
          blocks={editedInstant ? busyAt(editedInstant.toISOString(), busy) : []}
          testID={`review-busy-${item.itemId}`}
        />
      </View>
    </Btn>
  );
}
