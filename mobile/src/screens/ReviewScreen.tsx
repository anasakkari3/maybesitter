import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useCaptureFlow } from '../features/capture/CaptureProvider';
import { useTimeZone } from '../i18n/timezone';
import { formatRelativeDay, formatTime } from '../i18n/format';
import { ltr } from '../i18n/strings';
import { cardShadow } from '../theme/tokens';
import { Btn, FlowHeader, ImpBadge, Pill, Txt } from '../ui/primitives';
import { CheckIcon } from '../ui/icons';
import { ScreenIn } from '../ui/motion';
import type { CaptureProposalItem } from '../api/schemas/capture';

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
  const items = state.proposal?.items ?? [];
  const selectedCount = state.selected.length;
  const busy = state.status === 'confirming';

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <FlowHeader pill={t.back} onPill={() => flow.backToComposer()} title={t.reviewTitle} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: 18, paddingHorizontal: 20, paddingBottom: 20, gap: 14 }}
      >
        <Txt size={12} color={p.mu} style={{ paddingHorizontal: 4 }} testID="review-note">{t.suggestionNote}</Txt>

        {state.status === 'confirmFailed' ? (
          <View style={{ backgroundColor: p.wms, borderRadius: 18, padding: 14 }} testID="review-confirm-failed">
            <Txt size={14} color={p.wm}>{t.errorsGeneric}</Txt>
          </View>
        ) : null}

        {items.map((item) => (
          <ItemCard
            key={item.itemId}
            item={item}
            selected={state.selected.includes(item.itemId)}
            onToggle={() => flow.toggleItem(item.itemId)}
            lang={lang}
          />
        ))}
      </ScrollView>

      <View style={{ paddingTop: 12, paddingHorizontal: 20, paddingBottom: insets.bottom + 16, gap: 8, backgroundColor: p.bg, borderTopWidth: 1, borderTopColor: p.ln }}>
        {selectedCount === 0 ? (
          <Txt size={12} color={p.mu} align="center" testID="review-none-selected">{t.reviewNothingSelected}</Txt>
        ) : null}
        <Pill
          testID="review-confirm"
          label={tr('confirmN', { n: selectedCount })}
          onPress={() => void flow.confirm()}
          disabled={selectedCount === 0 || busy}
        />
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
  item, selected, onToggle, lang,
}: {
  item: CaptureProposalItem;
  selected: boolean;
  onToggle: () => void;
  lang: 'ar' | 'en';
}) {
  const { t, p } = useApp();
  const timezone = useTimeZone();
  const when = item.resolvedTime
    ? `${formatRelativeDay(new Date(item.resolvedTime), { locale: lang, timeZone: timezone })} · ${ltr(formatTime(new Date(item.resolvedTime), { locale: lang, timeZone: timezone }))}`
    : t.noTimeYet;

  return (
    <Btn
      testID={`review-item-${item.itemId}`}
      onPress={onToggle}
      scaleTo={0.99}
      label={`${item.title}, ${selected ? t.reviewSelected : t.reviewNotSelected}, ${when}`}
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
        <Txt size={18} weight={600} style={{ flex: 1 }}>{item.title}</Txt>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <View style={{ backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12 }}>
          <Txt size={13} testID={`review-when-${item.itemId}`}>{when}</Txt>
        </View>
        {item.priority ? <ImpBadge imp={PRIORITY_IMP[item.priority]} /> : null}
        {/* A guess named as one. A level presented as a fact the user stated is
            how a product loses the right to guess at all (#164). */}
        {item.priorityEstimated ? (
          <Txt size={12} color={p.mu} testID={`review-estimated-${item.itemId}`}>{t.reviewEstimated}</Txt>
        ) : null}
        {item.needsClarification ? (
          <View style={{ backgroundColor: p.wms, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10 }}>
            <Txt size={12} color={p.wm} testID={`review-needs-question-${item.itemId}`}>{t.reviewNeedsQuestion}</Txt>
          </View>
        ) : null}
      </View>
    </Btn>
  );
}
