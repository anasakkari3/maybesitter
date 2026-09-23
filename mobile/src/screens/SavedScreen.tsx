import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useCaptureFlow } from '../features/capture/CaptureProvider';
import { useTimeZone } from '../i18n/timezone';
import { dayKey, formatRelativeDay, formatTime } from '../i18n/format';
import { fill, ltr } from '../i18n/strings';
import { cardShadow } from '../theme/tokens';
import { Btn, Pill, Txt } from '../ui/primitives';
import { ActionRow, Tag } from '../ui/chrome';
import { CheckIcon, UndoRing } from '../ui/icons';
import { Pop, ScreenIn } from '../ui/motion';
import { UNDO_WINDOW_MS } from '../features/capture/captureMachine';
import type { UndoOutcome } from '../features/capture/CaptureProvider';

const TICK_MS = 1000;

/**
 * What was actually saved (UC-2.R2, #172).
 *
 * ── Only `persisted[]` ───────────────────────────────────────────
 *
 * This screen used to list `s.commitments.filter(c => savedIds.includes(c.id))`
 * — the client's own optimistic copy — so anything the server refused still
 * appeared here as saved. It now lists what the server said it wrote, and
 * `failed[]` separately with its reason. A confirm that half-succeeded is the
 * case this distinction exists for.
 *
 * ── Undo never overclaims ────────────────────────────────────────
 *
 * Undo deletes each persisted commitment one at a time. If some deletes fail,
 * the ones still saved are named. "Undone" is only ever said when nothing is
 * left, because a user who is told it was undone will stop checking.
 */
export function SavedScreen() {
  const { t, p, lang, actions } = useApp();
  const insets = useSafeAreaInsets();
  const timezone = useTimeZone();
  const flow = useCaptureFlow();
  const { state } = flow;
  const [outcome, setOutcome] = useState<UndoOutcome | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(Math.round(UNDO_WINDOW_MS / TICK_MS));
  const busy = useRef(false);

  // A display countdown only. The window itself is the provider's timer, so
  // navigating away cannot leave Undo armed against a screen that is gone.
  useEffect(() => {
    if (!state.undoable) return;
    const id = setInterval(() => setSecondsLeft((n) => (n > 0 ? n - 1 : 0)), TICK_MS);
    return () => clearInterval(id);
  }, [state.undoable]);

  const runUndo = () => {
    if (busy.current) return;
    busy.current = true;
    void flow.undo().then((result) => {
      setOutcome(result);
      busy.current = false;
    });
  };

  const finish = () => { flow.close(); actions.go('today'); };
  // «شوف اليوم» when everything landed today, «شوف الأسبوع» otherwise: the
  // day the things went to is where the person goes next.
  const today = dayKey(new Date(), timezone);
  const allToday = state.persisted.length > 0 && state.persisted.every((item) => item.resolvedTime && dayKey(new Date(item.resolvedTime), timezone) === today);
  const viewDay = () => { flow.close(); actions.go(allToday ? 'today' : 'calendar'); };

  const whenOf = (resolvedTime: string | null) => (resolvedTime
    ? `${formatRelativeDay(new Date(resolvedTime), { locale: lang, timeZone: timezone })} · ${ltr(formatTime(new Date(resolvedTime), { locale: lang, timeZone: timezone }))}`
    : t.noTimeYet);

  if (outcome) {
    const fully = outcome.stillSaved.length === 0;
    // `UndoOutcome` carries commitment ids; the user knows these by their
    // titles, so they are looked back up rather than printed as ids.
    const stillSavedTitles = outcome.stillSaved
      .map((id) => state.persisted.find((item) => item.commitmentId === id)?.title ?? id);
    return (
      <ScreenIn style={{ backgroundColor: p.bg, paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: insets.bottom + 24 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 24 }} testID="saved-undo-outcome">
          <Txt size={22} weight={600} align="center">
            {fully ? t.undoneTitle : t.undonePartialTitle}
          </Txt>
          {!fully ? (
            <Txt size={14} color={p.mu} align="center" testID="saved-undo-partial">
              {fill(t.undonePartialBody, { titles: stillSavedTitles.join('، ') })}
            </Txt>
          ) : null}
        </ScrollView>
        <Pill testID="saved-done" label={t.ok} onPress={finish} />
      </ScreenIn>
    );
  }

  return (
    <ScreenIn style={{ backgroundColor: p.bg, paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: insets.bottom + 24 }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 20, paddingVertical: 28 }}>
        <Pop>
          <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: p.ac, alignItems: 'center', justifyContent: 'center' }}>
            <CheckIcon size={38} color={p.onAccent} weight={2.5 / 2} />
          </View>
        </Pop>
        <Txt role="section" align="center" testID="saved-title">{t.savedTitle}</Txt>

        <View style={{ alignSelf: 'stretch', gap: 8, marginTop: 6 }}>
          {state.persisted.map((item) => (
            <View
              key={item.commitmentId}
              testID={`saved-item-${item.itemId}`}
              style={[{ backgroundColor: p.sf, borderRadius: 18, paddingVertical: 18, paddingHorizontal: 18, alignItems: 'stretch', gap: 10 }, cardShadow(p)]}
            >
              <Txt role="card">{item.title}</Txt>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                <Tag kind="saved" label={t.reviewConfirmedTag} />
                <Txt size={12} color={p.mu}>{whenOf(item.resolvedTime)}</Txt>
              </View>
            </View>
          ))}
        </View>

        {/* The server saved it and says what it lands on. It warns, it does not
            refuse, so this sits under the saved list rather than replacing it,
            and names what was already there so the user can decide. */}
        {state.collisions.length > 0 ? (
          <View style={{ alignSelf: 'stretch', gap: 6, marginTop: 4 }} testID="saved-collisions">
            {state.collisions.map((collision) => (
              <View key={collision.commitmentId} style={{ backgroundColor: p.wms, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 }}>
                <Txt size={13} color={p.wm} testID={`saved-collision-${collision.commitmentId}`}>
                  {fill(t.savedCollision, { title: collision.title, when: whenOf(collision.startsAt) })}
                </Txt>
              </View>
            ))}
          </View>
        ) : null}

        {/* Never mixed in with the saved list. A refused item shown among them
            is the product reporting a write that did not happen. */}
        {state.failed.length > 0 ? (
          <View style={{ alignSelf: 'stretch', gap: 6, marginTop: 4 }} testID="saved-failed">
            <Txt size={14} weight={600} color={p.wm}>{t.savedFailedTitle}</Txt>
            <Txt size={12} color={p.mu}>{t.savedFailedBody}</Txt>
            {state.failed.map((item) => (
              <View key={item.itemId} testID={`saved-failed-${item.itemId}`} style={{ backgroundColor: p.wms, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 }}>
                <Txt size={13} color={p.wm}>{item.itemId}</Txt>
              </View>
            ))}
          </View>
        ) : null}

        {state.undoable && state.persisted.length > 0 ? (
          <Btn
            testID="saved-undo"
            onPress={runUndo}
            label={t.undo}
            style={{ backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 10 }}
          >
            <Txt size={14}>{t.undo}</Txt>
            <View style={{ width: 26, height: 26, alignItems: 'center', justifyContent: 'center' }}>
              <UndoRing left={secondsLeft} track={p.ln} color={p.ac} />
              <Txt size={11} weight={600} align="center" lh={1.2}>{String(secondsLeft)}</Txt>
            </View>
          </Btn>
        ) : null}
      </ScrollView>

      <ActionRow>
        <Pill testID="saved-view-day" label={allToday ? t.tabToday : t.todayLaterSeeAll} onPress={viewDay} kind="outline" size={15} weight={500} />
        <Pill testID="saved-done" label={t.ok} onPress={finish} size={15} />
      </ActionRow>
    </ScreenIn>
  );
}
