import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useCaptureFlow } from '../features/capture/CaptureProvider';
import { ClarifySheet } from '../features/capture/ClarifySheet';
import { EditProposalItemSheet } from '../features/capture/EditProposalItemSheet';
import { questionText } from '../features/capture/clarificationCopy';
import { useTimeZone } from '../i18n/timezone';
import { formatRelativeDay, formatTime } from '../i18n/format';
import { ltr, type Lang } from '../i18n/strings';
import { cardShadow } from '../theme/tokens';
import { Btn, FlowHeader, ImpBadge, Pill, Txt } from '../ui/primitives';
import { CheckIcon } from '../ui/icons';
import { ScreenIn } from '../ui/motion';
import { instantForLocalDateTime } from '../features/capture/localInstant';
import { SeedProposalSection } from '../features/seeds/SeedProposalSection';
import { BusyConflictChip } from '../features/calendar/BusyConflictChip';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import { busyAt } from '../features/calendar/conflicts';
import { confirmableItems, type CaptureItemEdit } from '../features/capture/captureMachine';
import type { CaptureProposalItem } from '../api/schemas/capture';
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
  const flow = useCaptureFlow();
  const { state } = flow;
  const [answering, setAnswering] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const strings = t as unknown as Record<string, string>;
  // The local cache, not a request (UC-3.2, #186). A chip that had to wait for
  // the network would appear after the user had already pressed Confirm.
  const busyBlocks = useBusyBlocks();
  const items = state.proposal?.items ?? [];
  const seeds = state.proposal?.seeds ?? [];
  const selectedCount = state.selected.length;
  const busy = state.status === 'confirming';

  const confirmable = confirmableItems(state.proposal, state.edits);

  /**
   * The items still waiting on their one question (UC-2.5, #165).
   *
   * Asked one at a time. A question this build has no words for is not counted:
   * the item keeps its flag and #164's edit sheet is the way to fix it, which
   * can express anything a fixed question cannot.
   *
   * An item completed by hand / confirmable is skipped in the clarify queue (#503).
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
    void flow.clarify(itemId, value).then(() => {
      // A failure leaves the question up. Clearing it would look like the
      // answer landed.
      setAnswering(false);
    });
  };

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <FlowHeader pill={t.back} onPill={() => flow.backToComposer()} title={t.reviewTitle} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: 18, paddingHorizontal: 20, paddingBottom: 20, gap: 14 }}
      >
        <Txt size={12} color={p.mu} style={{ paddingHorizontal: 4 }} testID="review-note">{t.suggestionNote}</Txt>

        {asking ? (
          <View style={{ backgroundColor: p.sf, borderRadius: 24, padding: 18 }}>
            <ClarifySheet
              item={asking}
              position={unclarified.length - waiting.length + 1}
              total={unclarified.length}
              busy={answering}
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
            <Txt size={14} color={p.wm}>{t.errorsGeneric}</Txt>
          </View>
        ) : null}

        {items.map((item) => (
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
          />
        ))}

        {/* What the capture read as unresolved intent (#519). Its own section
            rather than more cards in the list above, because these are not
            items the confirm can carry: Keep is a separate call, and nothing
            here is selected, counted or written by the Confirm button. */}
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
              onChange={(next) => flow.editItem(editingItemId, next)}
              onClose={() => setEditingItemId(null)}
            />
          </View>
        ) : null}
      </ScrollView>

      <View style={{ paddingTop: 12, paddingHorizontal: 20, paddingBottom: insets.bottom + 16, gap: 8, backgroundColor: p.bg, borderTopWidth: 1, borderTopColor: p.ln }}>
        {/*
          A capture that named only a maybe has nothing to confirm (#519).

          Showing "Confirm 0", disabled, above "nothing selected" would read as
          a dead end the person has to work out for themselves — and the thing
          they came here to decide is already above, in its own section with
          its own Keep. So the confirm bar simply is not drawn, and the only
          button is the way out.
        */}
        {items.length === 0 ? null : (
          <>
            {selectedCount === 0 ? (
              <Txt size={12} color={p.mu} align="center" testID="review-none-selected">{t.reviewNothingSelected}</Txt>
            ) : null}
            <Pill
              testID="review-confirm"
              label={tr('confirmN', { n: selectedCount })}
              onPress={() => void flow.confirm()}
              disabled={selectedCount === 0 || busy}
            />
          </>
        )}
        <Pill
          testID="review-cancel"
          label={t.cancelAll}
          onPress={() => { flow.close(); actions.closeCapture(); }}
          kind="ghost"
          size={14}
          weight={400}
          pad={10}
        />
      </View>
    </ScreenIn>
  );
}

const PRIORITY_IMP = { high: 'must', normal: 'should', low: 'nice' } as const;

function ItemCard({
  item, edit, selected, needsQuestion, onToggle, onEdit, lang, busy,
}: {
  item: CaptureProposalItem;
  edit: CaptureItemEdit | undefined;
  selected: boolean;
  needsQuestion: boolean;
  onToggle: () => void;
  onEdit: () => void;
  lang: Lang;
  busy: readonly DeviceBusyBlock[];
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
  const when = editedInstant
    ? `${formatRelativeDay(editedInstant, { locale: lang, timeZone: timezone })} · ${ltr(formatTime(editedInstant, { locale: lang, timeZone: timezone }))}`
    : t.noTimeYet;
  const priority = edit?.priority ?? item.priority;

  return (
    <Btn
      testID={`review-item-${item.itemId}`}
      onPress={onToggle}
      scaleTo={0.99}
      label={`${title}, ${selected ? t.reviewSelected : t.reviewNotSelected}, ${when}`}
      style={[
        {
          backgroundColor: p.sf, borderRadius: 24, paddingVertical: 16, paddingHorizontal: 18, gap: 12,
          alignItems: 'flex-start',
          borderStartWidth: 4, borderStartColor: selected ? p.ac : p.ln,
          opacity: selected ? 1 : 0.55,
        },
        cardShadow(p),
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, alignSelf: 'stretch' }}>
        <View
          testID={`review-check-${item.itemId}`}
          style={{
            width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
            backgroundColor: selected ? p.ac : 'transparent',
            borderWidth: selected ? 0 : 2, borderColor: p.ln,
          }}
        >
          {selected ? <CheckIcon size={14} color={p.onAccent} /> : null}
        </View>
        <Txt size={18} weight={600} style={{ flex: 1 }}>{title}</Txt>
        <Btn
          testID={`review-edit-${item.itemId}`}
          label={t.reviewEdit}
          onPress={onEdit}
          style={{ backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 }}
        >
          <Txt size={12} weight={600} color={p.ac}>{t.reviewEdit}</Txt>
        </Btn>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <View style={{ backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12 }}>
          <Txt size={13} testID={`review-when-${item.itemId}`}>{when}</Txt>
        </View>
        {priority ? <ImpBadge imp={PRIORITY_IMP[priority]} /> : null}
        {/* A guess named as one — and no longer a guess once the user has set
            it themselves. A level presented as a fact they stated is how a
            product loses the right to guess at all (#164). */}
        {item.priorityEstimated && edit?.priority === undefined ? (
          <Txt size={12} color={p.mu} testID={`review-estimated-${item.itemId}`}>{t.reviewEstimated}</Txt>
        ) : null}
        {/* The "Needs one question" chip is hidden once the item is
            confirmable / completed by hand (#503). */}
        {needsQuestion ? (
          <View style={{ backgroundColor: p.wms, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10 }}>
            <Txt size={12} color={p.wm} testID={`review-needs-question-${item.itemId}`}>{t.reviewNeedsQuestion}</Txt>
          </View>
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
