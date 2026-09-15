import React, { useMemo, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { Btn, Card, Pill, Txt } from '../ui/primitives';
import { ScreenIn } from '../ui/motion';
import { SettingsHeader } from '../features/settings/SettingsChrome';
import { QueryBoundary } from '../api/ui/QueryBoundary';
import { useIsOnline } from '../api/ui/OfflineBanner';
import { usePlan, usePlanAction, usePlanEdit, usePlanSettings, useRegeneratePlan } from '../api/queries';
import { QuotaExceededError } from '../api/errors';
import { userFacingMessage } from '../api/ui/userFacingMessage';
import type { DailyPlan, PlanItem } from '../api/schemas/plan';
import { CIVIL_ZONE, civilDate, dayKey, formatRelativeDay, formatTime, formatTimeRange } from '../i18n/format';
import { isolateAuto } from '../i18n/bidi';
import { instantForLocalDateTime, localDateTimeFor } from '../features/capture/localInstant';
import { dateShowing, wallClockShown } from '../features/plan/pickerClock';
import { editRefusalOf, unplacedReason } from '../features/plan/reasons';
import { canRegenerate, rebuildsLeft } from '../features/plan/regenerateCap';
import { moveKeepingLength } from '../features/plan/optimisticEdit';
import { useOneAtATime } from '../features/plan/oneAtATime';

/**
 * Today's plan (UC-3.10b, #195).
 *
 * ── It is a proposal, and it says so ─────────────────────────────
 *
 * The server has already stored the plan; "Looks good" changes its *status*,
 * nothing else. Until then nothing has happened to a single commitment — moving
 * an item here says something about today, not about the obligation
 * (`PLANNING_PERSISTENCE_POLICY.originalCommitmentRemainsCanonical`, enforced
 * on the server side by #194).
 *
 * ── Nothing here is a failure ────────────────────────────────────
 *
 * An item the planner could not place is "kept for another time", with a plain
 * reason. Not "didn't fit", not "missed", and never the reason code. This
 * product has no "overdue" (AGENTS.md), and a morning screen that opened by
 * listing what somebody is behind on would be the exact opposite of what it is
 * for. `planCopy.test.ts` holds all three locales to that.
 *
 * ── Every time is read in the plan's own zone ────────────────────
 *
 * Not the device's. The plan carries the zone it was reasoned about in, and the
 * two differ for anybody who has travelled since this morning; rendering in the
 * device zone would move every row on screen while the plan itself stayed put.
 * The picker is the one place that has to work in the *device* zone — that is
 * the clock the wheel shows — so the conversion is explicit, both ways, through
 * `localInstant`, which reads offsets off the clock rather than off a label
 * Hermes does not report the way Node does.
 *
 * ── Offline ──────────────────────────────────────────────────────
 *
 * A plan already fetched in this session stays on screen, read-only, from the
 * in-memory query cache. A cold start with no signal shows the offline state,
 * because there is nothing to show and there is no disk copy — by design
 * (#157). Nothing is written to storage on either path.
 */
export function PlanScreen({ date, onBack }: { date: string; onBack: () => void }) {
  const { t, p, actions } = useApp();
  const insets = useSafeAreaInsets();
  const online = useIsOnline();
  const query = usePlan(date);
  const settings = usePlanSettings();

  const plan = query.data ?? null;
  // `undefined` is "no answer yet"; `null` is "the server says there is none".
  const answered = query.data !== undefined;

  // A cold start with no signal. Checked before the boundary, because React
  // Query pauses rather than fails when it is offline: the query would sit in
  // `isPending` forever and the screen would spin at somebody who is simply on
  // a train.
  if (!online && !answered) {
    return (
      <PlanFrame title={t.planTitle} onBack={onBack} insets={insets}>
        <Card pad={18}>
          <Txt size={15} color={p.mu} lh={1.5} testID="plan-offline-cold">{t.planOfflineCold}</Txt>
        </Card>
      </PlanFrame>
    );
  }

  return (
    <PlanFrame title={t.planTitle} onBack={onBack} insets={insets}>
      <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
        {plan ? (
          <LoadedPlan plan={plan} date={date} readOnly={!online} />
        ) : (
          <Card pad={18} style={{ gap: 12 }}>
            <Txt size={17} weight={600} testID="plan-empty">{t.planEmptyTitle}</Txt>
            <Txt size={14} color={p.mu} lh={1.5}>{t.planEmptyBody}</Txt>
            {/* Only when the server says delivery is off. Offering "turn it on"
                to somebody who already has it on would be telling them the
                wrong thing about their own settings. */}
            {settings.data?.enabled === false ? (
              <Pill
                label={t.planEmptyEnableCta}
                kind="outline"
                size={14}
                testID="plan-enable-morning"
                onPress={() => actions.go('notificationsSettings')}
              />
            ) : null}
          </Card>
        )}
      </QueryBoundary>
    </PlanFrame>
  );
}

function PlanFrame({
  title, onBack, insets, children,
}: {
  title: string;
  onBack: () => void;
  insets: { top: number };
  children: React.ReactNode;
}) {
  const { p } = useApp();
  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView
        testID="plan-screen"
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 60, gap: 14 }}
      >
        <SettingsHeader title={title} onBack={onBack} />
        {children}
      </ScrollView>
    </ScreenIn>
  );
}

function LoadedPlan({ plan, date, readOnly }: { plan: DailyPlan; date: string; readOnly: boolean }) {
  const { t, tr, p, lang } = useApp();
  const accept = usePlanAction(date);
  const edit = usePlanEdit(date);
  const rebuild = useRegeneratePlan(date);

  const [openItem, setOpenItem] = useState<string | null>(null);
  const zone = plan.timezone;

  /*
   * One tap, one request — enforced with refs rather than with `isPending`.
   *
   * `disabled` is a render behind the state it reads, so three fast taps on
   * "Looks good" all get through it. See `oneAtATime.ts`: the criterion is that
   * accept is sent *once*, and a rebuild repeated the same way would spend two
   * of the day's four generations and two model calls.
   */
  const accepting = useOneAtATime();
  const rebuilding = useOneAtATime();
  const editing = useOneAtATime();

  const send = (action: 'accept' | 'dismiss') => {
    if (!accepting.enter()) return;
    accept.mutate(action, { onSettled: accepting.leave });
  };

  const refusal = editRefusalOf(edit.error);
  // A 429 means another device spent the last rebuild between this screen's
  // read and this tap. The cap copy is the same either way.
  const capReached = !canRegenerate(plan.generation) || rebuild.error instanceof QuotaExceededError;
  const left = rebuildsLeft(plan.generation);

  const heading = useMemo(
    () => formatRelativeDay(civilDate(plan.date), {
      locale: lang,
      timeZone: CIVIL_ZONE,
      // "Today" has to mean today where the plan is, not where UTC is.
      now: civilDate(dayKey(new Date(), zone)),
    }),
    [plan.date, lang, zone],
  );

  const settled = plan.status === 'accepted' || plan.status === 'dismissed';

  return (
    <View style={{ gap: 14 }}>
      <Txt size={15} color={p.mu} testID="plan-date">{heading}</Txt>

      {readOnly ? (
        <Card pad={16}>
          <Txt size={14} color={p.mu} lh={1.5} testID="plan-offline-readonly">{t.planOfflineReadOnly}</Txt>
        </Card>
      ) : null}

      {/* Two sentences, one line. Right after the tap it confirms what just
          happened; on every later look it is a status. The app-wide toast sheet
          is deliberately not used: its only button is `closeSheetHome`, which
          would throw the user off this screen the moment they accepted the
          plan they were reading. */}
      {plan.status === 'accepted' ? (
        <Txt size={15} color={p.ac} testID="plan-accepted">
          {accept.isSuccess ? t.planAcceptedToast : t.planAcceptedStatus}
        </Txt>
      ) : null}
      {plan.status === 'dismissed' ? (
        <Txt size={15} color={p.mu} testID="plan-dismissed">{t.planDismissedStatus}</Txt>
      ) : null}

      {/* Why this plan. A quiet card, never a banner: it is context, not an
          instruction. The "written by the assistant" line appears only for
          `source: 'model'` — a templated sentence has no author to name, and
          badging it would claim a model wrote something it did not. */}
      <Card pad={18} style={{ gap: 8 }} testID="plan-why">
        <Txt size={13} weight={600} color={p.mu}>{t.planWhyTitle}</Txt>
        <Txt size={15} lh={1.5}>{isolateAuto(plan.explanation.text)}</Txt>
        {plan.explanation.source === 'model' ? (
          <Txt size={12} color={p.mu} testID="plan-model-note">{t.planWrittenByAssistant}</Txt>
        ) : null}
      </Card>

      <Txt size={13} weight={600} color={p.mu} style={{ paddingHorizontal: 4 }}>{t.planOrderTitle}</Txt>
      {plan.scheduled.length === 0 ? (
        <Card pad={18}>
          <Txt size={14} color={p.mu} testID="plan-nothing-placed">{t.planNothingPlaced}</Txt>
        </Card>
      ) : (
        <View style={{ gap: 10 }}>
          {plan.scheduled.map(item => (
            <PlannedRow
              key={item.itemId}
              item={item}
              zone={zone}
              readOnly={readOnly || settled}
              open={openItem === item.itemId}
              busy={edit.isPending}
              refusal={refusal?.itemId === item.itemId ? (t[refusal.key] as string) : null}
              onToggle={() => setOpenItem(current => (current === item.itemId ? null : item.itemId))}
              onMove={startsAt => {
                if (!editing.enter()) return;
                edit.reset();
                edit.mutate({ moves: [moveKeepingLength(item, startsAt)] }, {
                  onSuccess: () => setOpenItem(null),
                  onSettled: editing.leave,
                });
              }}
              onRemove={() => {
                if (!editing.enter()) return;
                edit.reset();
                edit.mutate({ removals: [item.itemId] }, {
                  onSuccess: () => setOpenItem(null),
                  onSettled: editing.leave,
                });
              }}
            />
          ))}
        </View>
      )}

      {/* A refusal with no row to sit under still has to be shown somewhere.
          Two ways that happens: it is about no item in particular (an empty
          edit, a move with no id), or it names one this screen is not showing
          — `unknown_item` is exactly the server saying "that is not in the
          plan I hold", which is the case where the row cannot be there. Keying
          this off `itemId === null` alone left that second one rendering
          nothing at all: the edit failed and the screen said so nowhere. */}
      {refusal && !plan.scheduled.some(item => item.itemId === refusal.itemId) ? (
        <Txt size={13} color={p.wm} testID="plan-edit-refused">{t[refusal.key] as string}</Txt>
      ) : null}
      {/* Anything that is not a refusal is an error like any other, and gets
          the one copy table this app has for errors. */}
      {edit.error && !refusal ? (
        <Txt size={13} color={p.wm} testID="plan-edit-error">{userFacingMessage(edit.error, t)}</Txt>
      ) : null}

      {plan.unscheduled.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Txt size={13} weight={600} color={p.mu} style={{ paddingHorizontal: 4 }}>{t.planKeptTitle}</Txt>
          <Card pad={0} style={{ overflow: 'hidden' }} testID="plan-kept">
            {plan.unscheduled.map((item, index) => (
              <View
                key={item.itemId}
                testID={`plan-kept-${item.itemId}`}
                style={{
                  paddingHorizontal: 18, paddingVertical: 14, gap: 4,
                  borderTopWidth: index === 0 ? 0 : 1, borderTopColor: p.ln,
                }}
              >
                <Txt size={15}>{item.title ? isolateAuto(item.title) : t.planRemovedItem}</Txt>
                <Txt size={13} color={p.mu} lh={1.5}>{unplacedReason(item.reasonCode, t)}</Txt>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      <View style={{ gap: 10, paddingTop: 6 }}>
        <Pill
          label={t.planAccept}
          testID="plan-accept"
          // Disabled once it is accepted, and while the one request is in
          // flight. "Looks good" sends exactly one accept: the criterion is
          // about the request count, not about how fast somebody taps.
          disabled={readOnly || accept.isPending || plan.status === 'accepted'}
          onPress={() => send('accept')}
        />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pill
            label={t.planRegenerate}
            kind="outline"
            size={14}
            style={{ flex: 1 }}
            testID="plan-regenerate"
            disabled={readOnly || rebuild.isPending || capReached}
            onPress={() => {
              if (!rebuilding.enter()) return;
              rebuild.mutate(undefined, { onSettled: rebuilding.leave });
            }}
          />
          <Pill
            label={t.planDismiss}
            kind="ghost"
            size={14}
            style={{ flex: 1 }}
            testID="plan-dismiss"
            disabled={readOnly || accept.isPending || plan.status === 'dismissed'}
            onPress={() => send('dismiss')}
          />
        </View>
        {capReached ? (
          <Txt size={13} color={p.mu} lh={1.5} testID="plan-regenerate-capped">{t.planRegenerateNoneLeft}</Txt>
        ) : (
          <Txt size={13} color={p.mu} testID="plan-regenerate-left">{tr('planRegenerateLeft', { n: left })}</Txt>
        )}
        {/* A rebuild that failed for any other reason. */}
        {rebuild.error && !capReached ? (
          <Txt size={13} color={p.wm} testID="plan-regenerate-error">{userFacingMessage(rebuild.error, t)}</Txt>
        ) : null}
      </View>
    </View>
  );
}

function PlannedRow({
  item, zone, readOnly, open, busy, refusal, onToggle, onMove, onRemove,
}: {
  item: PlanItem;
  zone: string;
  readOnly: boolean;
  open: boolean;
  busy: boolean;
  refusal: string | null;
  onToggle: () => void;
  onMove: (startsAt: Date) => void;
  onRemove: () => void;
}) {
  const { t, p, lang, scheme } = useApp();
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Date | null>(null);

  const start = new Date(item.startsAt);
  const end = new Date(item.endsAt);
  // Zero-length placements exist: the adapter this backend ships gives every
  // item a zero buffer, and the fixtures have `startsAt === endsAt`. A range
  // rendered as "09:00–09:00" says nothing, so one time is shown instead.
  const when = item.startsAt === item.endsAt
    ? formatTime(start, { locale: lang, timeZone: zone })
    : formatTimeRange(start, end, { locale: lang, timeZone: zone });

  /*
   * The wheel draws the OS's clock face, whatever zone the plan is in.
   *
   * So it is opened *showing* the item's wall-clock time in the plan's zone,
   * and whatever face the user leaves it on is read back as a wall clock and
   * turned into an instant in the plan's zone. Both halves, or a plan built in
   * Jerusalem and edited on a phone in Berlin lands two hours out — and only
   * for the user who travelled, which is nobody's test run.
   */
  const wheelValue = dateShowing(localDateTimeFor(start, zone));
  const pickedLabel = picked ? formatTime(picked, { locale: lang, timeZone: zone }) : null;

  return (
    <Card pad={0} style={{ overflow: 'hidden' }} testID={`plan-item-${item.itemId}`}>
      <Btn
        label={item.title ?? t.planRemovedItem}
        testID={`plan-open-${item.itemId}`}
        onPress={readOnly ? undefined : onToggle}
        disabled={readOnly}
        scaleTo={readOnly ? 1 : 0.98}
        style={{ paddingHorizontal: 18, paddingVertical: 14, gap: 4, alignItems: 'flex-start' }}
      >
        <Txt size={13} color={p.mu} latin testID={`plan-item-time-${item.itemId}`}>{when}</Txt>
        <Txt size={15}>{item.title ? isolateAuto(item.title) : t.planRemovedItem}</Txt>
      </Btn>

      {refusal ? (
        <Txt
          size={13}
          color={p.wm}
          lh={1.5}
          style={{ paddingHorizontal: 18, paddingBottom: 12 }}
          testID={`plan-item-refused-${item.itemId}`}
        >
          {refusal}
        </Txt>
      ) : null}

      {open && !readOnly ? (
        <View style={{ paddingHorizontal: 18, paddingBottom: 16, gap: 10, borderTopWidth: 1, borderTopColor: p.ln, paddingTop: 14 }}>
          <Pill
            label={pickedLabel ? `${t.planChangeTime} · ${pickedLabel}` : t.planEditPickTime}
            kind="outline"
            size={14}
            testID={`plan-pick-${item.itemId}`}
            onPress={() => setPicking(true)}
          />
          {picking ? (
            <DateTimePicker
              testID={`plan-picker-${item.itemId}`}
              value={picked ?? wheelValue}
              mode="time"
              // 15 minutes, as #195 asks. Always 24-hour, because `formatTime`
              // is: the label beside the wheel reads "18:00" in all three
              // languages, and a 12-hour wheel next to it was the defect the
              // capture sheet already found.
              minuteInterval={15}
              is24Hour
              themeVariant={scheme}
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(event, value) => {
                setPicking(Platform.OS === 'ios');
                // A dismissed Android picker hands back the value it opened
                // with, which is not a choice.
                if (event.type === 'dismissed' || !value) return;
                setPicked(instantForLocalDateTime(wallClockShown(value), zone));
              }}
            />
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pill
              label={t.planEditSave}
              size={14}
              style={{ flex: 1 }}
              testID={`plan-move-${item.itemId}`}
              disabled={busy || picked === null}
              onPress={() => { if (picked) onMove(picked); }}
            />
            <Pill
              label={t.planTakeOff}
              kind="warm"
              size={14}
              style={{ flex: 1 }}
              testID={`plan-remove-${item.itemId}`}
              disabled={busy}
              onPress={onRemove}
            />
          </View>
          <Pill
            label={t.planEditCancel}
            kind="ghost"
            size={14}
            testID={`plan-cancel-${item.itemId}`}
            onPress={() => { setPicked(null); setPicking(false); onToggle(); }}
          />
        </View>
      ) : null}
    </Card>
  );
}
