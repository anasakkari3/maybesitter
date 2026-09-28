import React, { useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useAcceptWeekDay, useWeek } from '../../api/queries';
import { ConflictError, QuotaExceededError, WeekConflictError } from '../../api/errors';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import type { WeekDecisions } from '../../api/endpoints/plans';
import type { Week, WeekDay, WeekItem, WeekRow, WeekStepReason } from '../../api/schemas/plan';
import { CIVIL_ZONE, civilDate, formatDate, formatRelativeDay, formatTime, formatTimeRange } from '../../i18n/format';
import { isolateAuto } from '../../i18n/bidi';
import { fill } from '../../i18n/strings';
import { useLayoutMode } from '../../theme/textScale';
import { Btn, Card, Pill, Txt } from '../../ui/primitives';
import { EmptyState, SectionLabel, Tag, TextLink } from '../../ui/chrome';
import { ProductPage } from '../../ui/product';

/**
 * «خطّط أسبوعي» — weekly planning mode (CL5b; council verdict item 6).
 *
 * One card per day, today and the six after it. A day that is still a
 * suggestion shows the one step the daily planner proposes for it, fitted
 * around that day's busy time, beside the day's fixed-time commitments; the
 * person saves the day, moves the step to another day, or takes it off the
 * week. A day that already has a plan shows that plan and opens it.
 *
 * ── Nothing is saved until "Save this day" ────────────────────────
 *
 * Moves and drops are this screen's state, in memory, and are sent with every
 * request: the server composes the week under them and stores nothing. Saving
 * a day is the only write, and it stores that date's plan exactly as the
 * daily flow does, so Today and the plan screen show it on its date. Leaving
 * the screen forgets the unsaved decisions, which is what a suggestion is.
 *
 * «مش بالأيام اللي بحفظها» / "Not in days I save" is deliberately not
 * «أسقطه بوعي»: it keeps a step out of the days saved from this screen and
 * changes nothing about the commitment. It is screen-only, so its words
 * promise no more than that — a morning plan may still offer the step.
 *
 * ── The day saved is the day shown (I1) ───────────────────────────
 *
 * "Save this day" sends the steps its card shows, and is held while the week
 * on screen is being redrawn (a move or a drop keeps the previous week on
 * screen while the next one is composed). If the account changed meanwhile,
 * the server refuses with the fresh week, which is drawn in place, and the
 * person is told in one short line.
 */
export function WeekScreen() {
  const { t, p } = useApp();
  const [decisions, setDecisions] = useState<WeekDecisions>({ moves: [], drops: [] });
  const query = useWeek(decisions);
  const week = query.data;

  const move = (itemId: string, date: string) => setDecisions(current => ({
    moves: [...current.moves.filter(existing => existing.itemId !== itemId), { itemId, date }],
    drops: current.drops.filter(existing => existing !== itemId),
  }));
  const drop = (itemId: string) => setDecisions(current => ({
    moves: current.moves.filter(existing => existing.itemId !== itemId),
    drops: [...current.drops.filter(existing => existing !== itemId), itemId],
  }));
  const undrop = (itemId: string) => setDecisions(current => ({ ...current, drops: current.drops.filter(existing => existing !== itemId) }));

  // The day's limit is a limit, not a failure: its own short line, no retry
  // that would fail the same way until tomorrow (I5).
  const limited = query.error instanceof QuotaExceededError;
  // The week on screen is the previous one while the next is composed; a
  // save from it would save a card that is about to change (I1).
  const redrawing = query.isFetching || query.isPlaceholderData;

  return (
    <ProductPage id="week" title={t.weekTitle} subtitle={t.weekBody}>
      <Txt role="supporting" color={p.mu} testID="week-proposal-note">{t.suggestionNote}</Txt>
      {limited ? (
        <EmptyState testID="week-limit" title={t.weekLimitReached} top={24} />
      ) : (
        <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
          {week ? <WeekBody week={week} decisions={decisions} redrawing={redrawing} onMove={move} onDrop={drop} onUndrop={undrop} /> : null}
        </QueryBoundary>
      )}
    </ProductPage>
  );
}

/** A save's failure, in the words that fit it. */
function saveErrorText(error: unknown, t: ReturnType<typeof useApp>['t']): string {
  if (error instanceof WeekConflictError && error.reason === 'week_changed') return t.weekChanged;
  if (error instanceof ConflictError) return t.weekAlreadyPlanned;
  if (error instanceof QuotaExceededError) return t.weekLimitReached;
  return userFacingMessage(error, t);
}

function WeekBody({ week, decisions, redrawing, onMove, onDrop, onUndrop }: {
  week: Week;
  decisions: WeekDecisions;
  redrawing: boolean;
  onMove: (itemId: string, date: string) => void;
  onDrop: (itemId: string) => void;
  onUndrop: (itemId: string) => void;
}) {
  const { t, p } = useApp();
  const save = useAcceptWeekDay(decisions);
  const [moving, setMoving] = useState<string | null>(null);
  const [savedDate, setSavedDate] = useState<string | null>(null);

  const empty = week.days.every(day => day.items.length === 0 && day.fixed.length === 0 && day.allDay.length === 0) && week.drops.length === 0;
  if (empty) return <EmptyState testID="week-empty" title={t.weekEmpty} body={t.weekEmptyBody} top={24} />;

  // Only a day that is still a suggestion can take a step; a stored day is
  // the plan the person already has.
  const targets = week.days.filter(day => day.state === 'proposed').map(day => day.date);

  const saveDay = (day: WeekDay) => {
    if (save.isPending || redrawing) return;
    const shown = [...day.items.map(item => item.itemId), ...day.unplaced.map(item => item.itemId)];
    save.mutate({ date: day.date, shown }, {
      onSuccess: () => {
        setSavedDate(day.date);
        AccessibilityInfo.announceForAccessibility(t.weekSavedToast);
      },
      onError: error => AccessibilityInfo.announceForAccessibility(saveErrorText(error, t)),
    });
  };

  return (
    <View style={{ gap: 14 }}>
      {week.days.map(day => (
        <DayCard
          key={day.date}
          day={day}
          today={week.today}
          zone={week.timezone}
          targets={targets.filter(date => date !== day.date)}
          moving={moving}
          saving={save.isPending && save.variables?.date === day.date}
          busy={save.isPending || redrawing}
          justSaved={savedDate === day.date}
          error={save.isError && save.variables?.date === day.date ? save.error : null}
          onSave={() => saveDay(day)}
          onToggleMove={itemId => setMoving(current => (current === itemId ? null : itemId))}
          onMove={(itemId, date) => { setMoving(null); onMove(itemId, date); }}
          onDrop={itemId => { setMoving(null); onDrop(itemId); }}
        />
      ))}

      {week.waiting > 0 ? (
        <Txt role="supporting" color={p.mu} testID="week-waiting">{fill(t.weekWaiting, { n: week.waiting })}</Txt>
      ) : null}

      {week.drops.length > 0 ? (
        <View style={{ gap: 8 }} testID="week-dropped">
          <SectionLabel>{t.weekDroppedTitle}</SectionLabel>
          {week.drops.map(dropped => (
            <Card key={dropped.itemId} pad={14} style={{ backgroundColor: p.sf2 }}>
              <View style={{ gap: 4, alignItems: 'flex-start' }}>
                <Txt size={15}>{dropped.title ? isolateAuto(dropped.title) : t.planRemovedItem}</Txt>
                <TextLink label={t.weekUndrop} onPress={() => onUndrop(dropped.itemId)} testID={`week-undrop-${dropped.itemId}`} />
              </View>
            </Card>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const REASON_KEY: Record<WeekStepReason, 'weekReasonDue' | 'weekReasonDueLater' | 'weekReasonDueEarlier' | 'weekReasonCarried' | 'weekReasonOpen' | 'weekReasonMoved'> = {
  due: 'weekReasonDue',
  // Pulled ahead of its due day because that day was taken (N3).
  due_later: 'weekReasonDueLater',
  // Due on an earlier day that is still ahead: not «من يوم فات» (FX1).
  due_earlier: 'weekReasonDueEarlier',
  carried: 'weekReasonCarried',
  open: 'weekReasonOpen',
  moved: 'weekReasonMoved',
};

function DayCard({
  day, today, zone, targets, moving, saving, busy, justSaved, error, onSave, onToggleMove, onMove, onDrop,
}: {
  day: WeekDay;
  today: string;
  zone: string;
  targets: readonly string[];
  moving: string | null;
  saving: boolean;
  busy: boolean;
  justSaved: boolean;
  error: unknown;
  onSave: () => void;
  onToggleMove: (itemId: string) => void;
  onMove: (itemId: string, date: string) => void;
  onDrop: (itemId: string) => void;
}) {
  const { t, p, lang, actions } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  const heading = formatRelativeDay(civilDate(day.date), { locale: lang, timeZone: CIVIL_ZONE, now: civilDate(today) });
  // Floating work and fixed-time commitments, in the order the day runs.
  const rows = [
    ...day.items.map(item => ({ kind: 'item' as const, at: Date.parse(item.startsAt), item })),
    ...day.fixed.map(row => ({ kind: 'fixed' as const, at: Date.parse(row.startsAt), row })),
  ].sort((a, b) => a.at - b.at);
  const proposed = day.state === 'proposed';

  return (
    <Card testID={`week-day-${day.date}`} style={{ gap: 12 }}>
      <View style={{ flexDirection: stacked ? 'column' : 'row', justifyContent: 'space-between', alignItems: stacked ? 'flex-start' : 'center', gap: 8 }}>
        <Txt role="section">{heading}</Txt>
        {proposed ? <Tag kind="proposal" label={t.weekProposal} testID={`week-state-${day.date}`} /> : null}
        {day.state === 'planned' ? <Tag kind="muted" label={t.weekPlanned} testID={`week-state-${day.date}`} /> : null}
        {day.state === 'accepted' ? <Tag kind="started" label={t.weekSaved} testID={`week-state-${day.date}`} /> : null}
      </View>

      {rows.length === 0 && day.allDay.length === 0 ? <Txt role="supporting" color={p.mu} testID={`week-free-${day.date}`}>{t.weekFreeDay}</Txt> : null}
      {/* An appointment with no hour opens its day, as a calendar puts an
          all-day event (UAT round 3, N13). A day holding one is not free. */}
      {day.allDay.map(row => <AllDayWeekRow key={`allday-${row.itemId}`} row={row} />)}
      {rows.map(entry => entry.kind === 'fixed' ? (
        <FixedWeekRow key={`fixed-${entry.row.itemId}`} row={entry.row} zone={zone} />
      ) : proposed ? (
        <StepRow
          key={entry.item.itemId}
          item={entry.item}
          zone={zone}
          targets={targets}
          today={today}
          open={moving === entry.item.itemId}
          busy={busy}
          onToggleMove={() => onToggleMove(entry.item.itemId)}
          onMove={date => onMove(entry.item.itemId, date)}
          onDrop={() => onDrop(entry.item.itemId)}
        />
      ) : (
        <PlanWeekRow key={entry.item.itemId} item={entry.item} zone={zone} />
      ))}
      {day.unplaced.map(item => (
        <Txt key={`unplaced-${item.itemId}`} role="supporting" color={p.mu} testID={`week-noroom-${item.itemId}`}>
          {`${item.title ? isolateAuto(item.title) : t.planRemovedItem} · ${t.weekNoRoom}`}
        </Txt>
      ))}

      {proposed && day.items.length > 0 ? (
        <Pill
          testID={`week-save-${day.date}`}
          label={saving ? `${t.weekSaveDay}…` : t.weekSaveDay}
          disabled={busy}
          onPress={onSave}
        />
      ) : null}
      {!proposed ? (
        <View style={{ gap: 4, alignItems: 'flex-start' }}>
          {justSaved ? <Txt size={13} weight={600} color={p.acd} testID={`week-saved-${day.date}`}>{t.weekSavedToast}</Txt> : null}
          <TextLink label={t.weekOpenPlan} onPress={() => actions.openPlan(day.date)} testID={`week-open-${day.date}`} />
        </View>
      ) : null}
      {error ? (
        <Txt role="supporting" color={p.wm} testID={`week-error-${day.date}`}>
          {saveErrorText(error, t)}
        </Txt>
      ) : null}
    </Card>
  );
}

function when(row: { startsAt: string; endsAt: string }, lang: 'ar' | 'en' | 'he', zone: string): string {
  const start = new Date(row.startsAt);
  return row.startsAt === row.endsAt
    ? formatTime(start, { locale: lang, timeZone: zone })
    : formatTimeRange(start, new Date(row.endsAt), { locale: lang, timeZone: zone });
}

/** The proposed step: time, title, why it is on this day, and the two choices. */
function StepRow({ item, zone, targets, today, open, busy, onToggleMove, onMove, onDrop }: {
  item: WeekItem;
  zone: string;
  targets: readonly string[];
  today: string;
  open: boolean;
  busy: boolean;
  onToggleMove: () => void;
  onMove: (date: string) => void;
  onDrop: () => void;
}) {
  const { t, p, lang } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  const title = item.title ? isolateAuto(item.title) : t.planRemovedItem;
  const time = when(item, lang, zone);
  const reason = item.reason ? t[REASON_KEY[item.reason]] : null;
  return (
    <View testID={`week-step-${item.itemId}`} style={{ gap: 10, borderStartWidth: 3, borderColor: p.prop, paddingStart: 12 }}>
      <View accessible accessibilityRole="text" accessibilityLabel={[title, time, reason].filter(Boolean).join(lang === 'ar' ? '، ' : ', ')} style={{ gap: 4, alignItems: 'flex-start' }}>
        <Txt size={13} weight={600} latin color={p.mu}>{time}</Txt>
        <Txt size={16}>{title}</Txt>
        {reason ? <Txt role="supporting" color={p.mu}>{reason}</Txt> : null}
      </View>
      <View style={{ flexDirection: stacked ? 'column' : 'row', flexWrap: 'wrap', gap: 8 }}>
        {targets.length > 0 ? (
          <Pill testID={`week-move-${item.itemId}`} label={open ? t.weekMoveCancel : t.weekMove} kind="soft" size={14} pad={10} disabled={busy} onPress={onToggleMove} />
        ) : null}
        <Pill testID={`week-drop-${item.itemId}`} label={t.weekDrop} kind="outline" size={14} pad={10} disabled={busy} onPress={onDrop} />
      </View>
      {open ? (
        <View style={{ gap: 8 }} testID={`week-move-to-${item.itemId}`}>
          <Txt role="label" color={p.mu}>{t.weekMoveTo}</Txt>
          {/* One-shot actions, not a selection: buttons, each naming its day (M-c). */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {targets.map(date => {
              const label = formatRelativeDay(civilDate(date), { locale: lang, timeZone: CIVIL_ZONE, now: civilDate(today) });
              return (
                <Btn
                  key={date}
                  testID={`week-move-${item.itemId}-${date}`}
                  label={label}
                  accessibilityRole="button"
                  onPress={() => onMove(date)}
                  style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf }}
                >
                  <Txt size={14}>{formatDate(civilDate(date), 'weekdayShort', { locale: lang, timeZone: CIVIL_ZONE })}</Txt>
                </Btn>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** A commitment pinned to a time on the day: fixed, never moved, not a button. */
function FixedWeekRow({ row, zone }: { row: WeekRow; zone: string }) {
  const { t, p, lang } = useApp();
  const title = row.title ? isolateAuto(row.title) : t.planRemovedItem;
  const time = when(row, lang, zone);
  return (
    <View testID={`week-fixed-${row.itemId}`} accessible accessibilityRole="text" accessibilityLabel={[title, time, t.planItemFixed].join(lang === 'ar' ? '، ' : ', ')}
      style={{ gap: 4, alignItems: 'flex-start', backgroundColor: p.sf2, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 }}>
      <Txt size={13} weight={600} latin color={p.mu}>{time}</Txt>
      <Txt size={15}>{title}</Txt>
      <Tag kind="fixed" label={t.planItemFixed} />
    </View>
  );
}

/**
 * An appointment on the day with no hour (FY1's all-day event, UAT round 3
 * N13): the fixed row's look, «بدون وقت» where the time would be — the words
 * the Calendar uses for the same item. Never a step: nothing to move or drop.
 */
function AllDayWeekRow({ row }: { row: WeekDay['allDay'][number] }) {
  const { t, p, lang } = useApp();
  const title = row.title ? isolateAuto(row.title) : t.planRemovedItem;
  return (
    <View testID={`week-allday-${row.itemId}`} accessible accessibilityRole="text" accessibilityLabel={[title, t.noTimeYet, t.planItemFixed].join(lang === 'ar' ? '، ' : ', ')}
      style={{ gap: 4, alignItems: 'flex-start', backgroundColor: p.sf2, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 }}>
      <Txt size={13} weight={600} color={p.mu}>{t.noTimeYet}</Txt>
      <Txt size={15}>{title}</Txt>
      <Tag kind="fixed" label={t.planItemFixed} />
    </View>
  );
}

/**
 * A row of a day that already has a plan: what that plan holds, read only, with
 * the same due line it was proposed with (N3: a saved row dropped it).
 */
function PlanWeekRow({ item, zone }: { item: WeekItem; zone: string }) {
  const { t, p, lang } = useApp();
  const title = item.title ? isolateAuto(item.title) : t.planRemovedItem;
  const time = when(item, lang, zone);
  const reason = item.reason ? t[REASON_KEY[item.reason]] : null;
  return (
    <View testID={`week-row-${item.itemId}`} accessible accessibilityRole="text" accessibilityLabel={[title, time, reason].filter(Boolean).join(lang === 'ar' ? '، ' : ', ')} style={{ gap: 4, alignItems: 'flex-start' }}>
      <Txt size={13} weight={600} latin color={p.mu}>{time}</Txt>
      <Txt size={15}>{title}</Txt>
      {reason ? <Txt role="supporting" color={p.mu} testID={`week-row-reason-${item.itemId}`}>{reason}</Txt> : null}
    </View>
  );
}
