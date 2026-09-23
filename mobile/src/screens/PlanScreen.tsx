import React, { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useLayoutMode } from '../theme/textScale';
import { useApp } from '../state/AppContext';
import { Btn, Card, Pill, Txt } from '../ui/primitives';
import { ActionRow, BackHeader, EmptyState, SectionLabel, Skeleton, Tag, TextLink } from '../ui/chrome';
import { Screen, ScreenScroll } from '../ui/screen';
import { ProcessingDots } from '../ui/motion';
import { QueryBoundary } from '../api/ui/QueryBoundary';
import { useIsOnline } from '../api/ui/OfflineBanner';
import {
  useAnalyticsConsent,
  useBuildPlan,
  usePlan,
  usePlanAction,
  usePlanEdit,
  usePlanSettings,
  useRecordAnalytics,
  useRegeneratePlan,
} from '../api/queries';
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
import {
  reportPlanDecision,
  reportPlanEdited,
  reportPlanOpened,
  reportPlanRegenerated,
  type PlanReporter,
} from '../features/plan/planAnalytics';

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
  const { t, p } = useApp();
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
      <PlanFrame title={t.planTitle} onBack={onBack}>
        <Card pad={18}>
          <Txt size={15} color={p.mu} lh={1.5} testID="plan-offline-cold">{t.planOfflineCold}</Txt>
        </Card>
      </PlanFrame>
    );
  }

  return (
    <PlanFrame title={t.planTitle} onBack={onBack}>
      <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
        {plan ? (
          <LoadedPlan plan={plan} date={date} readOnly={!online} />
        ) : (
          <EmptyPlan date={date} online={online} deliveryOn={settings.data?.enabled} />
        )}
      </QueryBoundary>
    </PlanFrame>
  );
}

/**
 * No plan for the day yet (#477).
 *
 * The morning job used to be the only thing that could build one, so this was
 * a dead end for anybody whose morning had not run. The build here is the same
 * server build without the push, and it is idempotent, so the worst a stale
 * screen can do is get back the plan that already exists.
 *
 * The body tells the truth about the setting: with delivery off it offers the
 * build *and* the way to turn delivery on; otherwise — on, or not answered yet —
 * it says nothing about a switch the user may already have flipped.
 *
 * With no signal there is nothing to build with, so it says so and offers
 * nothing. `LoadedPlan` replaces this in place when the answer lands, because
 * `useBuildPlan` writes it into the plan query this screen is reading.
 */
function EmptyPlan({ date, online, deliveryOn }: { date: string; online: boolean; deliveryOn: boolean | undefined }) {
  const { t, p, actions } = useApp();
  const build = useBuildPlan(date);
  const building = useOneAtATime();
  const deliveryOff = deliveryOn === false;

  if (build.isPending) return <Generating />;
  return (
    <EmptyState
      testID="plan-empty"
      top={40}
      title={t.planEmptyTitle}
      body={online ? (deliveryOff ? t.planEmptyBody : t.planEmptyBodyReady) : t.planOfflineCold}
      action={online ? (
        <View style={{ alignItems: 'center', gap: 6, marginTop: 6 }}>
          <Pill
            label={t.planEmptyBuildCta}
            size={15}
            pad={12}
            testID="plan-build"
            disabled={build.isPending}
            style={{ paddingHorizontal: 22 }}
            onPress={() => {
              // One tap, one request: see `oneAtATime.ts`.
              if (!building.enter()) return;
              build.mutate(undefined, { onSettled: building.leave });
            }}
          />
          {build.error ? (
            <Txt size={13} color={p.wm} testID="plan-build-error">{userFacingMessage(build.error, t)}</Txt>
          ) : null}
          {/* Only when the server says delivery is off. Offering "turn it on"
              to somebody who already has it on would be telling them the
              wrong thing about their own settings. */}
          {deliveryOff ? (
            <TextLink label={t.planEmptyEnableCta} onPress={() => actions.go('notificationsSettings')} testID="plan-enable-morning" />
          ) : null}
        </View>
      ) : <Txt size={13} color={p.mu} testID="plan-empty-offline">{''}</Txt>}
    />
  );
}

/** The planner at work: Round 2's dots, the sentence, and the shape of what is coming. */
function Generating() {
  const { t, p } = useApp();
  return (
    <View style={{ gap: 14 }} testID="plan-generating">
      <View style={{ alignItems: 'center', gap: 14, paddingTop: 40, paddingHorizontal: 20, paddingBottom: 10 }}>
        <ProcessingDots color={p.ac} />
        <Txt size={17} weight={600} align="center">{t.planGeneratingTitle}</Txt>
        <Txt size={14} color={p.mu} align="center">{t.planGeneratingSub}</Txt>
      </View>
      <Skeleton heights={[64, 64, 64]} label={t.planGeneratingTitle} />
    </View>
  );
}

function PlanFrame({
  title, onBack, children,
}: {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <Screen pinned={<BackHeader title={title} onBack={onBack} />}>
      <ScreenScroll testID="plan-screen">{children}</ScreenScroll>
    </Screen>
  );
}

function LoadedPlan({ plan, date, readOnly }: { plan: DailyPlan; date: string; readOnly: boolean }) {
  const { t, tr, p, lang } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  const accept = usePlanAction(date);
  const edit = usePlanEdit(date);
  const rebuild = useRegeneratePlan(date);

  const [openItem, setOpenItem] = useState<string | null>(null);
  const zone = plan.timezone;

  /*
   * Analytics (#195 step 7), consent-gated and content-free.
   *
   * `useAnalyticsConsent` reads the trust record only when something is about
   * to be reported, and fails closed. Everything else here is fire-and-forget:
   * a metrics call is never awaited into something the user is waiting on, and
   * `planAnalytics.ts` swallows its own failures.
   *
   * The handlers below close over this render's `reporter`, which is all an
   * event handler needs. The mount effect closes over the *first* render's,
   * deliberately — `plan_opened` is about the plan being put on screen, not
   * about how many times React re-rendered it, and accepting rewrites the
   * cached plan and re-renders this component.
   */
  const analyticsConsent = useAnalyticsConsent();
  const recordAnalytics = useRecordAnalytics();
  const record = recordAnalytics.mutate;
  const reporter = useMemo<PlanReporter>(
    () => ({ analyticsConsent, report: event => record(event) }),
    [analyticsConsent, record],
  );

  // One per plan the screen actually shows, keyed by `date` rather than by the
  // plan object, which every action replaces.
  useEffect(() => {
    void reportPlanOpened(plan, reporter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

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
    accept.mutate(action, {
      // Reported from the plan the server answered with, not the one on screen
      // when the button was pressed.
      onSuccess: settledPlan => void reportPlanDecision(action, settledPlan, reporter),
      onSettled: accepting.leave,
    });
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
  const proposal = !settled;
  // The explanation is rendered only in the language the app is showing.
  // The route says which language it wrote in; when that is not this one,
  // a templated sentence stands in rather than a paragraph the reader may
  // not read (Round 2: never raw server text in the wrong language).
  const explanationInLanguage = plan.explanation.locale === lang;
  const [whyOpen, setWhyOpen] = useState(true);

  if (rebuild.isPending) return <Generating />;

  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: stacked ? 'column' : 'row', justifyContent: 'space-between', alignItems: stacked ? 'flex-start' : 'center', gap: 10, paddingHorizontal: 4 }}>
        <Txt size={15} color={p.mu} testID="plan-date">{heading}</Txt>
        {proposal ? <Tag kind="proposal" label={t.planStatusProposal} testID="plan-status-proposal" /> : null}
      </View>

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
        <View style={{ alignSelf: 'flex-start', backgroundColor: p.acs, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 12 }}>
          <Txt size={13} weight={600} color={p.acd} testID="plan-accepted">
            {accept.isSuccess ? t.planAcceptedToast : t.planAcceptedStatus}
          </Txt>
        </View>
      ) : null}
      {plan.status === 'dismissed' ? (
        <Txt size={14} color={p.mu} testID="plan-dismissed">{t.planDismissedStatus}</Txt>
      ) : null}
      {proposal ? <Txt size={13} color={p.mu} style={{ paddingHorizontal: 4 }} testID="plan-proposal-note">{t.suggestionNote}</Txt> : null}

      <SectionLabel>{t.planOrderTitle}</SectionLabel>
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
                const moving = { moves: [moveKeepingLength(item, startsAt)] };
                edit.mutate(moving, {
                  onSuccess: () => {
                    setOpenItem(null);
                    void reportPlanEdited(moving, null, reporter);
                  },
                  onError: error => void reportPlanEdited(moving, error, reporter),
                  onSettled: editing.leave,
                });
              }}
              onRemove={() => {
                if (!editing.enter()) return;
                edit.reset();
                const removing = { removals: [item.itemId] };
                edit.mutate(removing, {
                  onSuccess: () => {
                    setOpenItem(null);
                    void reportPlanEdited(removing, null, reporter);
                  },
                  onError: error => void reportPlanEdited(removing, error, reporter),
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

      {/* Why this plan. A quiet card, never a banner: it is context, not an
          instruction, and it folds. The "written by the assistant" line
          appears only for `source: 'model'` — a templated sentence has no
          author to name. */}
      <Card pad={0} style={{ overflow: 'hidden' }} testID="plan-why">
        <Btn label={t.planWhyTitle} onPress={() => setWhyOpen(!whyOpen)} testID="plan-why-toggle" accessibilityState={{ expanded: whyOpen }} scaleTo={0.99} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, minHeight: 48 }}>
          <Txt size={15} weight={600}>{t.planWhyTitle}</Txt>
          <Txt size={13} color={p.mu}>{whyOpen ? '−' : '+'}</Txt>
        </Btn>
        {whyOpen ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 14, gap: 8 }}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.ac, marginTop: 8 }} />
              <Txt size={14} color={p.mu} lh={1.55} style={{ flex: 1 }} testID="plan-why-text">
                {explanationInLanguage ? isolateAuto(plan.explanation.text) : t.planWhyFallback}
              </Txt>
            </View>
            {explanationInLanguage && plan.explanation.source === 'model' ? (
              <Txt size={12} color={p.mu} testID="plan-model-note">{t.planWrittenByAssistant}</Txt>
            ) : null}
            {proposal ? (
              <Txt size={12} color={p.mu} lh={1.5} style={{ borderTopWidth: 1, borderTopColor: p.ln, paddingTop: 8 }}>{t.planWhatHappens}</Txt>
            ) : null}
          </View>
        ) : null}
      </Card>

      <View style={{ gap: 10, paddingTop: 6 }}>
        <Pill
          label={t.planAccept}
          size={17}
          pad={14}
          testID="plan-accept"
          // Disabled once it is accepted, and while the one request is in
          // flight. "Looks good" sends exactly one accept: the criterion is
          // about the request count, not about how fast somebody taps. It
          // stays drawn after acceptance, disabled, so the footer does not
          // jump under the finger that just pressed it.
          disabled={readOnly || accept.isPending || plan.status === 'accepted'}
          onPress={() => send('accept')}
        />
        <ActionRow>
          <Pill
            label={t.planRegenerate}
            kind="outline"
            size={14}
            testID="plan-regenerate"
            disabled={readOnly || rebuild.isPending || capReached}
            onPress={() => {
              if (!rebuilding.enter()) return;
              rebuild.mutate(undefined, {
                onSuccess: rebuilt => void reportPlanRegenerated(rebuilt, reporter),
                onSettled: rebuilding.leave,
              });
            }}
          />
          <Pill
            label={t.planDismiss}
            kind="ghost"
            size={14}
            testID="plan-dismiss"
            disabled={readOnly || accept.isPending || plan.status === 'dismissed'}
            onPress={() => send('dismiss')}
          />
        </ActionRow>
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
  const stacked = useLayoutMode() !== 'normal';
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
        style={{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 16, minHeight: 56 }}
      >
        {/* Round 2's row: the start time in its own column, a bar in the
            item's colour, then the title with its range and whether it moves. */}
        <Txt size={13} weight={600} latin testID={`plan-item-time-${item.itemId}`} style={stacked ? undefined : { minWidth: 48 }}>{formatTime(start, { locale: lang, timeZone: zone })}</Txt>
        {!stacked ? <View style={{ width: 2, alignSelf: 'stretch', borderRadius: 2, backgroundColor: p.lnStrong, minHeight: 28 }} /> : null}
        <View style={{ ...(stacked ? {} : { flex: 1 }), gap: 4 }}>
          <Txt size={15}>{item.title ? isolateAuto(item.title) : t.planRemovedItem}</Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Txt size={12} color={p.mu} latin>{when}</Txt>
            <Txt size={12} color={p.mu}>·</Txt>
            <Txt size={12} color={p.mu}>{readOnly ? t.planItemFixed : t.planItemMovable}</Txt>
          </View>
        </View>
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
