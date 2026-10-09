import React from 'react';
import { AccessibilityInfo, TextInput, View } from 'react-native';
import type { GoalPlan, GoalPlanStep, GoalPlanTimes, GoalPlanTimesStep, GoalPlanSlot, GoalPlanWeekly, GoalPlanPhase, GoalPlanRhythm } from '../../api/schemas/goalPlan';
import type { GoalPlanEditOp } from '../../api/endpoints/goalPlan';
import { GoalPlanRefusedError } from '../../api/errors';
import { isolateAuto } from '../../i18n/bidi';
import { civilDate, formatDate, formatTimeRange, formatClockRange, dayKey, formatDayKey } from '../../i18n/format';
import { fill } from '../../i18n/strings';
import { useTimeZone } from '../../i18n/timezone';
import { useApp } from '../../state/AppContext';
import { useLayoutMode } from '../../theme/textScale';
import { LiveRegion } from '../../ui/liveRegion';
import { useAnnounceOnIos } from '../../ui/announce';
import { Btn, Card, Pill, Txt } from '../../ui/primitives';
import { ProductActions, useRevealInPage } from '../../ui/product';
import { ReferenceIcon } from '../../ui/referenceIcons';
import { planFailureOf, recoveryLabel, type PlanRecovery } from './planFailures';
import { AllTimesSheet } from './AllTimesSheet';
import { habitStart, type HabitStart } from './habitStart';
import type { LiveStep, PlanFlow as Flow } from './useGoalPlanFlow';

/**
 * The plan path's screens (M3a): summary, the ordered plan and its whole-plan
 * edit, the times, what will be saved, and the result. Every entry renders
 * this one component over `useGoalPlanFlow`, so «اعمللي خطة» on a goal and
 * «اقترحلي خطة» in the panel are the same screens, as the owner asked.
 *
 * What it keeps from the product's rules:
 * - Nothing is saved before «احفظ»; the plan says it is a suggestion.
 * - Explanations («ليش هون؟», «شو بتطلع فيه») are behind a control, closed.
 * - Every failure names what happened and offers one way on (planFailures).
 * - One live line says where the request is: started, the step, done, could not.
 */
export function PlanFlowView({ flow, onRecover, hostRecoveries, linkedWork }: {
  flow: Flow;
  /** The ways on that leave the flow: capture, thoughts, goals, the new goal, Today. */
  onRecover: (recovery: PlanRecovery | 'open_today', detail: { currentGoalId?: string | undefined }) => void;
  /**
   * Which of those ways this host really performs. A failure never offers a
   * button its screen cannot carry out (inspection A-009); the flow's own
   * recoveries (try again, the simple plan, the new times…) are always there.
   */
  hostRecoveries: readonly PlanRecovery[];
  /** Work already linked to this goal, listed above a new plan so a repeat can be removed (S1). */
  linkedWork?: React.ReactNode;
}) {
  const { state } = flow;
  const { stage } = state;
  return <View style={{ gap: 14 }} testID="plan-flow">
    <LiveStatus flow={flow} />
    {stage.kind === 'summary' ? <SummaryStep flow={flow} /> : null}
    {stage.kind === 'plan' ? <PlanStep flow={flow} plan={stage.plan} linkedWork={linkedWork} /> : null}
    {stage.kind === 'times' ? <TimesStep flow={flow} times={stage.times} plan={stage.plan} /> : null}
    {stage.kind === 'confirm' ? <ConfirmStep flow={flow} times={stage.times} plan={stage.plan} /> : null}
    {stage.kind === 'result' ? <ResultStep result={stage.result} onOpenToday={() => onRecover('open_today', {})} /> : null}
    <FailureCard flow={flow} onRecover={onRecover} hostRecoveries={hostRecoveries} />
  </View>;
}

/* ── the live line ─────────────────────────────────────────────────── */

function LiveStatus({ flow }: { flow: Flow }) {
  const { t } = useApp();
  const { live } = flow.state;
  const thinking: Record<LiveStep, string> = {
    summary: t.xPlanStateSummary, plan: t.xPlanStatePlan, times: t.xPlanStateTimes, editing: t.xPlanStateEditing, saving: t.xPlanStateSaving,
  };
  const line = live.phase === 'thinking' ? thinking[live.step]
    : live.phase === 'started' ? t.xPlanStateStarted
      : live.phase === 'done' ? t.xPlanStateDone
        : live.phase === 'failed' ? t.xPlanStateFailed : null;
  const { p } = useApp();
  // iOS has no live regions (ui/liveRegion.tsx): VoiceOver is told the line,
  // and on a failure what went wrong, which the line alone does not say.
  const failure = live.phase === 'failed' ? planFailureOf(flow.state.error, t) : null;
  useAnnounceOnIos(failure ? `${line} ${failure.message}` : line);
  // TalkBack reads the region's line as it changes; on a failure the line
  // carries what went wrong, which the short visible «ما زبط» alone does not.
  return <LiveRegion testID="plan-live-status">
    {line ? <View accessible accessibilityLabel={failure ? `${line}. ${failure.message}` : line}>
      {/* Quiet: on a failure the card below says what happened, in its own colour. */}
      <Txt role="metadata" color={p.mu}>{line}</Txt>
    </View> : null}
  </LiveRegion>;
}


/**
 * A step's heading takes a screen reader's focus when the step appears, so
 * moving from the plan to the times (or to the result) is heard, not only seen.
 */
function StepHeading({ children, testID, color }: { children: string; testID?: string; color?: string }) {
  const ref = React.useRef<View>(null);
  const reveal = useRevealInPage();
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (!ref.current) return;
      // Seen and heard: the page scrolls to the new step (simulator pass A-3),
      // and a screen reader moves to its heading.
      reveal(ref.current);
      AccessibilityInfo.sendAccessibilityEvent(ref.current, 'focus');
    }, 50);
    return () => clearTimeout(timer);
  }, [reveal]);
  return <View ref={ref} accessible accessibilityRole="header" {...(testID ? { testID } : {})}><Txt role="section" color={color}>{children}</Txt></View>;
}

/* ── summary ───────────────────────────────────────────────────────── */

function SummaryStep({ flow }: { flow: Flow }) {
  const { t, p, rtl } = useApp();
  const stage = flow.state.stage;
  const [editing, setEditing] = React.useState(false);
  if (stage.kind !== 'summary') return null;
  return <Card testID="plan-summary" style={{ gap: 12 }}>
    <StepHeading>{t.xPlanSummaryTitle}</StepHeading>
    {editing && !flow.state.summaryLocked ? <TextInput
      testID="plan-summary-input"
      accessibilityLabel={t.xPlanSummaryInput}
      value={stage.text}
      onChangeText={flow.setSummaryText}
      maxLength={200}
      multiline
      autoFocus
      style={{ color: p.tx, backgroundColor: p.bg, padding: 14, minHeight: 60, borderRadius: 14, fontSize: 17, textAlign: rtl ? 'right' : 'left' }}
    /> : <Txt testID="plan-summary-text" role="body" weight={600}>{stage.text}</Txt>}
    <ProductActions>
      <Pill testID="plan-summary-confirm" label={t.xPlanSummaryConfirm} disabled={flow.state.busy || !stage.text.trim()} onPress={flow.acceptSummary} />
      {!editing && !flow.state.summaryLocked ? <Pill testID="plan-summary-edit" label={t.xPlanSummaryEdit} kind="outline" disabled={flow.state.busy} onPress={() => setEditing(true)} /> : null}
    </ProductActions>
  </Card>;
}

/* ── the plan ──────────────────────────────────────────────────────── */

function phaseLabel(phase: GoalPlanPhase, t: { xPlanPhaseDay: string; xPlanPhaseWeek: string }): string {
  return fill(phase.unit === 'day' ? t.xPlanPhaseDay : t.xPlanPhaseWeek, { n: phase.index });
}

function rhythmLine(rhythm: GoalPlanRhythm, tr: (key: 'xPlanTimesPerWeek', values: { n: number }) => string, t: { xPlanMorning: string; xPlanAfternoon: string; xPlanEvening: string }): string {
  const when = rhythm.timeOfDay === 'morning' ? t.xPlanMorning : rhythm.timeOfDay === 'afternoon' ? t.xPlanAfternoon : rhythm.timeOfDay === 'evening' ? t.xPlanEvening : null;
  return [tr('xPlanTimesPerWeek', { n: rhythm.timesPerWeek }), when].filter(Boolean).join('، ');
}

function PlanStep({ flow, plan, linkedWork }: { flow: Flow; plan: GoalPlan; linkedWork?: React.ReactNode }) {
  const { t, p } = useApp();
  const [editing, setEditing] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const addToggle = React.useRef<View>(null);
  const busy = flow.state.busy;
  const phases = React.useMemo(() => {
    const groups: { phase: GoalPlanPhase; steps: GoalPlanStep[] }[] = [];
    for (const step of [...plan.steps].sort((a, b) => a.order - b.order)) {
      const last = groups[groups.length - 1];
      if (last && last.phase.unit === step.phase.unit && last.phase.index === step.phase.index) last.steps.push(step);
      else groups.push({ phase: step.phase, steps: [step] });
    }
    return groups;
  }, [plan.steps]);
  const count = plan.steps.length;
  const lastStepId = [...plan.steps].sort((a, b) => a.order - b.order)[count - 1]?.stepId ?? null;

  return <View style={{ gap: 14 }}>
    {linkedWork}
    <Txt role="supporting" color={p.wm}>{t.suggestionNote}</Txt>
    {phases.map(group => <View key={`${group.phase.unit}-${group.phase.index}`} style={{ gap: 10 }} accessibilityRole="list">
      <Txt role="label" weight={700} testID={`plan-phase-${group.phase.unit}-${group.phase.index}`}>{phaseLabel(group.phase, t)}</Txt>
      {group.steps.map(step => <StepCard
        key={step.stepId}
        step={step}
        plan={plan}
        editing={editing}
        busy={busy}
        first={step.order === 1}
        last={step.stepId === lastStepId}
        onEdit={flow.edit}
      />)}
    </View>)}
    {plan.removedSteps.length > 0 ? <View style={{ gap: 8 }}>
      {plan.removedSteps.map(removed => <View key={removed.stepId} testID={`plan-removed-${removed.stepId}`} style={{ gap: 6 }}>
        <Txt role="supporting" color={p.mu}>{fill(t.xPlanRemoved, { step: isolateAuto(removed.title) })}</Txt>
        {editing ? <Pill testID={`plan-restore-${removed.stepId}`} label={t.xPlanRestore} kind="outline" disabled={busy}
          onPress={() => flow.edit({ op: 'restore', stepId: removed.stepId })} /> : null}
      </View>)}
    </View> : null}
    {editing && adding ? <StepEditor
      returnFocusTo={addToggle}
      idPrefix="plan-add"
      plan={plan}
      initial={{ title: '', kind: 'commitment', durationMinutes: 30, phase: plan.steps[0]?.phase ?? { unit: plan.horizon === 'days' ? 'day' : 'week', index: 1 } }}
      busy={busy}
      saveTestID="plan-add-save"
      onCancel={() => setAdding(false)}
      onSave={fields => {
        // The person picks the step's phase, not its slot inside it: null
        // appends it at the end of that phase (WIRE-M3a.md).
        flow.edit({ op: 'add', afterStepId: null, step: {
          title: fields.title, kind: fields.kind, phase: fields.phase, durationMinutes: fields.durationMinutes,
          ...(fields.kind === 'habit' && fields.rhythm ? { rhythm: fields.rhythm } : {}),
        } });
        setAdding(false);
      }}
    /> : null}
    <ProductActions>
      {editing ? <>
        {!adding ? <Pill nativeRef={addToggle} testID="plan-add-step" label={t.xPlanAddStep} kind="outline" disabled={busy || count >= 12} onPress={() => setAdding(true)} /> : null}
        <Pill testID="plan-edit-done" label={t.xPlanEditDone} disabled={busy} onPress={() => { setEditing(false); setAdding(false); }} />
      </> : <>
        <Pill testID="plan-approve" label={t.xPlanApprove} disabled={busy || count === 0} onPress={flow.approve} />
        <Pill testID="plan-edit" label={t.xPlanEdit} kind="outline" disabled={busy} onPress={() => setEditing(true)} />
      </>}
    </ProductActions>
  </View>;
}

function StepCard({ step, plan, editing, busy, first, last, onEdit }: {
  step: GoalPlanStep;
  plan: GoalPlan;
  editing: boolean;
  busy: boolean;
  first: boolean;
  last: boolean;
  onEdit: (op: GoalPlanEditOp) => void;
}) {
  const { t, tr, p } = useApp();
  const [open, setOpen] = React.useState(false);
  const editToggle = React.useRef<View>(null);
  const title = isolateAuto(step.title);
  return <Card testID={`plan-step-${step.stepId}`} style={{ gap: 8 }}>
    <Txt role="body" weight={700}>{step.title}</Txt>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Txt role="metadata" color={p.mu} testID={`plan-step-kind-${step.stepId}`}>{step.kind === 'habit' ? t.xPlanKindHabit : t.xPlanKindOnce}</Txt>
      <Txt role="metadata" color={p.mu} testID={`plan-step-duration-${step.stepId}`}>{tr('xMinutes', { count: step.durationMinutes })}</Txt>
      {step.kind === 'habit' && step.rhythm ? <Txt role="metadata" color={p.mu} testID={`plan-step-rhythm-${step.stepId}`}>{rhythmLine(step.rhythm, tr, t)}</Txt> : null}
    </View>
    {step.buildsOn ? <Reason id={`plan-step-why-${step.stepId}`} label={t.xPlanStepWhy} body={step.buildsOn} /> : null}
    {step.expectedOutcome ? <Reason id={`plan-step-outcome-${step.stepId}`} label={t.xPlanStepOutcome} body={step.expectedOutcome} /> : null}
    {editing ? <>
      <ProductActions>
        <Pill testID={`plan-move-up-${step.stepId}`} label={t.xPlanMoveUp} accessibilityLabel={fill(t.xPlanMoveUpLabel, { step: title })} kind="outline" disabled={busy || first}
          onPress={() => onEdit({ op: 'reorder', stepId: step.stepId, toOrder: step.order - 1 })} />
        <Pill testID={`plan-move-down-${step.stepId}`} label={t.xPlanMoveDown} accessibilityLabel={fill(t.xPlanMoveDownLabel, { step: title })} kind="outline" disabled={busy || last}
          onPress={() => onEdit({ op: 'reorder', stepId: step.stepId, toOrder: step.order + 1 })} />
        <Pill nativeRef={editToggle} testID={`plan-edit-step-${step.stepId}`} label={t.xPlanEditStep} kind="outline" disabled={busy} expanded={open} onPress={() => setOpen(v => !v)} />
        <Pill testID={`plan-remove-${step.stepId}`} label={t.xPlanRemove} kind="warm" disabled={busy || plan.steps.length <= 1}
          onPress={() => onEdit({ op: 'remove', stepId: step.stepId })} />
      </ProductActions>
      {open ? <StepEditor
        returnFocusTo={editToggle}
        idPrefix={`plan-edit`}
        idSuffix={step.stepId}
        plan={plan}
        initial={{ title: step.title, kind: step.kind, durationMinutes: step.durationMinutes, phase: step.phase, ...(step.rhythm ? { rhythm: step.rhythm } : {}) }}
        busy={busy}
        saveTestID={`plan-edit-save-${step.stepId}`}
        onCancel={() => setOpen(false)}
        onSave={fields => {
          const changed: Extract<GoalPlanEditOp, { op: 'update' }>['fields'] = {};
          if (fields.title !== step.title) changed.title = fields.title;
          if (fields.kind !== step.kind) changed.kind = fields.kind;
          if (fields.durationMinutes !== step.durationMinutes) changed.durationMinutes = fields.durationMinutes;
          if (fields.phase.unit !== step.phase.unit || fields.phase.index !== step.phase.index) changed.phase = fields.phase;
          if (fields.kind === 'habit' && fields.rhythm && JSON.stringify(fields.rhythm) !== JSON.stringify(step.rhythm)) changed.rhythm = fields.rhythm;
          if (Object.keys(changed).length > 0) onEdit({ op: 'update', stepId: step.stepId, fields: changed });
          setOpen(false);
        }}
      /> : null}
    </> : null}
  </Card>;
}

/** «ليش هون؟» / «شو بتطلع فيه»: a named control, closed until pressed; the line is absent while closed. */
function Reason({ id, label, body }: { id: string; label: string; body: string }) {
  const { p, t } = useApp();
  const [open, setOpen] = React.useState(false);
  return <View style={{ gap: 4 }}>
    <Btn testID={id} label={label} hint={open ? t.memoryWhyHide : undefined} accessibilityState={{ expanded: open }} onPress={() => setOpen(v => !v)}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}>
      <Txt role="supporting" color={p.ac}>{label}</Txt>
      <ReferenceIcon name={open ? 'chevron-up' : 'chevron-down'} size={16} color={p.mu} />
    </Btn>
    {open ? <Txt role="supporting" color={p.mu} testID={`${id}-body`}>{isolateAuto(body)}</Txt> : null}
  </View>;
}

/* ── the step editor (add and update) ──────────────────────────────── */

interface StepFields {
  title: string;
  kind: 'commitment' | 'habit';
  durationMinutes: number;
  phase: GoalPlanPhase;
  rhythm?: GoalPlanRhythm;
}

const DURATIONS = [15, 30, 45, 60, 90] as const;
const TIMES_PER_WEEK = [1, 2, 3, 4, 5, 7] as const;
const TIMES_OF_DAY = ['any', 'morning', 'afternoon', 'evening'] as const;

/**
 * One choice among a few, as a row of pills. The row takes a value through
 * `onValueChange` too, so a test (or an assistive tool) can set it the way a
 * picker is set.
 */
function Choice<T>({ testID, label, options, value, onValueChange, describe }: {
  testID: string;
  label: string;
  options: readonly T[];
  value: T;
  onValueChange: (value: T) => void;
  describe: (value: T) => string;
}) {
  const { p } = useApp();
  const same = (a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
  return <View testID={testID} accessibilityRole="radiogroup" accessibilityLabel={label} style={{ gap: 6 }} {...({ onValueChange } as object)}>
    <Txt role="metadata" color={p.mu}>{label}</Txt>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map(option => {
        const checked = same(option, value);
        // A radio, so a screen reader says which one is chosen, not only that
        // each is a button. 48 high: over the 44-point target at every size.
        return <Btn key={JSON.stringify(option)} label={describe(option)} accessibilityRole="radio" accessibilityState={{ checked }}
          onPress={() => onValueChange(option)}
          style={{ minHeight: 48, paddingHorizontal: 16, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
            backgroundColor: checked ? p.ac : p.sf, borderWidth: checked ? 0 : 1, borderColor: p.ln }}>
          <Txt size={13} weight={600} color={checked ? p.onAccent : p.tx} align="center">{describe(option)}</Txt>
        </Btn>;
      })}
    </View>
  </View>;
}

function StepEditor({ idPrefix, idSuffix, plan, initial, busy, saveTestID, onSave, onCancel, returnFocusTo }: {
  /** Where a screen reader goes back to when the editor closes (inspection A-010). */
  returnFocusTo?: React.RefObject<View | null>;
  idPrefix: string;
  idSuffix?: string;
  plan: GoalPlan;
  initial: StepFields;
  busy: boolean;
  saveTestID: string;
  onSave: (fields: StepFields) => void;
  onCancel: () => void;
}) {
  const { t, tr, p, rtl } = useApp();
  const [fields, setFields] = React.useState<StepFields>(initial);
  // Opening moves a screen reader into the editor; closing returns it to the
  // control that opened it, so nobody has to hunt for where they were.
  const titleField = React.useRef<TextInput>(null);
  React.useEffect(() => {
    const opened = setTimeout(() => { if (titleField.current) AccessibilityInfo.sendAccessibilityEvent(titleField.current as never, 'focus'); }, 50);
    const back = returnFocusTo;
    return () => {
      clearTimeout(opened);
      setTimeout(() => { if (back?.current) AccessibilityInfo.sendAccessibilityEvent(back.current, 'focus'); }, 50);
    };
  }, [returnFocusTo]);
  const id = (name: string) => idSuffix ? `${idPrefix}-${name}-${idSuffix}` : `${idPrefix}-${name}`;
  const unit: 'day' | 'week' = plan.horizon === 'days' ? 'day' : 'week';
  const maxIndex = Math.max(unit === 'day' ? 7 : 4, ...plan.steps.map(step => step.phase.index), fields.phase.index);
  const phases = Array.from({ length: maxIndex }, (_, i) => ({ unit, index: i + 1 }));
  const durations = DURATIONS.includes(fields.durationMinutes as typeof DURATIONS[number]) ? [...DURATIONS] : [...DURATIONS, fields.durationMinutes].sort((a, b) => a - b);
  const rhythm = fields.rhythm ?? { timesPerWeek: 3 };
  const set = (next: Partial<StepFields>) => setFields(current => ({ ...current, ...next }));
  const valid = fields.title.trim().length > 0 && fields.title.trim().length <= 120;
  return <Card style={{ gap: 12 }}>
    <TextInput
      ref={titleField}
      testID={id('title')}
      accessibilityLabel={t.xPlanStepTitleLabel}
      placeholder={t.xPlanStepTitleLabel}
      placeholderTextColor={p.mu}
      value={fields.title}
      onChangeText={title => set({ title })}
      maxLength={120}
      style={{ color: p.tx, backgroundColor: p.bg, padding: 12, minHeight: 48, borderRadius: 14, fontSize: 17, textAlign: rtl ? 'right' : 'left' }}
    />
    <Choice testID={id('kind')} label={t.xPlanKindLabel} options={['commitment', 'habit'] as const} value={fields.kind}
      onValueChange={kind => set({ kind, ...(kind === 'habit' && !fields.rhythm ? { rhythm } : {}) })}
      describe={kind => kind === 'habit' ? t.xPlanKindHabit : t.xPlanKindOnce} />
    {fields.kind === 'habit' ? <Choice testID={id('rhythm')} label={t.xPlanRhythmLabel}
      options={TIMES_PER_WEEK.map(timesPerWeek => ({ ...rhythm, timesPerWeek }))} value={rhythm}
      onValueChange={next => set({ rhythm: next })} describe={value => tr('xPlanTimesPerWeek', { n: value.timesPerWeek })} /> : null}
    {fields.kind === 'habit' ? <Choice testID={id('time-of-day')} label={t.xPlanTimeOfDayLabel}
      options={TIMES_OF_DAY} value={rhythm.timeOfDay ?? 'any'}
      onValueChange={(when: typeof TIMES_OF_DAY[number]) => set({ rhythm: when === 'any' ? { timesPerWeek: rhythm.timesPerWeek } : { timesPerWeek: rhythm.timesPerWeek, timeOfDay: when } })}
      describe={when => when === 'morning' ? t.xPlanMorning : when === 'afternoon' ? t.xPlanAfternoon : when === 'evening' ? t.xPlanEvening : t.xPlanAnyTime} /> : null}
    <Choice testID={id('duration')} label={t.xPlanDurationLabel} options={durations} value={fields.durationMinutes}
      onValueChange={durationMinutes => set({ durationMinutes })} describe={minutes => tr('xMinutes', { count: minutes })} />
    <Choice testID={id('phase')} label={t.xPlanPhaseLabel} options={phases} value={fields.phase}
      onValueChange={phase => set({ phase })} describe={phase => phaseLabel(phase, t)} />
    <ProductActions>
      <Pill testID={saveTestID} label={t.xPlanSaveStep} disabled={busy || !valid} onPress={() => onSave({ ...fields, title: fields.title.trim() })} />
      <Pill label={t.cancel} kind="outline" disabled={busy} onPress={onCancel} />
    </ProductActions>
  </Card>;
}

/* ── times ─────────────────────────────────────────────────────────── */

function weekdayName(weekday: number, lang: Parameters<typeof formatDate>[2]['locale']): string {
  // 2024-01-07 was a Sunday; the civil date is printed in UTC so no zone moves it.
  return formatDate(civilDate(`2024-01-${String(7 + weekday).padStart(2, '0')}`), 'weekdayShort', { locale: lang, timeZone: 'UTC' });
}

function useSlotLine(): (slot: GoalPlanSlot) => string {
  const { lang } = useApp();
  const timeZone = useTimeZone();
  return React.useCallback((slot: GoalPlanSlot) => {
    const start = new Date(slot.startsAt);
    const day = formatDayKey(dayKey(start, timeZone), { locale: lang, timeZone });
    return `${isolateAuto(day)} · ${formatTimeRange(start, new Date(slot.endsAt), { locale: lang, timeZone })}`;
  }, [lang, timeZone]);
}

/**
 * A habit's line: its weekdays and its time, led by when its week begins if
 * that is not this week (#751): «من الأسبوع الجاي · خميس، جمعة · 08:00».
 */
function useWeeklyLine(): (weekly: GoalPlanWeekly, start?: HabitStart) => string {
  const { t, lang } = useApp();
  return React.useCallback((weekly: GoalPlanWeekly, start?: HabitStart) => {
    const line = `${weekly.weekdays.map(day => weekdayName(day, lang)).join('، ')} · ${formatClockRange(weekly.start, weekly.end)}`;
    if (!start || start.kind === 'now') return line;
    const from = start.kind === 'next_week' ? t.xPlanFromNextWeek
      : fill(t.xPlanFromDate, { date: isolateAuto(formatDate(civilDate(start.key), 'short', { locale: lang, timeZone: 'UTC' })) });
    return `${from} · ${line}`;
  }, [t, lang]);
}

/** When each habit step's week begins, read from the plan the times belong to. */
function useHabitStarts(times: GoalPlanTimes, plan: GoalPlan | null): (stepId: string) => HabitStart {
  const timeZone = useTimeZone();
  const today = dayKey(new Date(), timeZone);
  return React.useCallback((stepId: string) =>
    habitStart(plan?.steps.find(step => step.stepId === stepId)?.phase, times.anchor.localDate, today),
  [plan, times.anchor.localDate, today]);
}

const isSlot = (value: GoalPlanSlot | GoalPlanWeekly): value is GoalPlanSlot => 'startsAt' in value;

/** A step's place in the proposal is one of three shapes (WIRE); these read it without guessing. */
const laterOf = (step: GoalPlanTimesStep) => ('later' in step ? step.later : null);
const slotOf = (step: GoalPlanTimesStep) => ('slot' in step ? step.slot : null);
const weeklyOf = (step: GoalPlanTimesStep) => ('weekly' in step ? step.weekly : null);
const reasonOf = (step: GoalPlanTimesStep) => ('reason' in step ? step.reason ?? null : null);
const alternativesOf = (step: GoalPlanTimesStep): (GoalPlanSlot | GoalPlanWeekly)[] => ('alternatives' in step ? step.alternatives : []);

/** What a step will be when the person presses «احفظ» — the same rule the result is read by. */
export function stepOutcome(step: GoalPlanTimesStep): 'save' | 'later' | 'no_room' {
  if (laterOf(step)) return 'later';
  if (slotOf(step) || weeklyOf(step)) return 'save';
  // A reason the person did not answer with «بلا وقت» means there was no
  // room, and it stays a suggestion. «بلا وقت» saves it without a time
  // (M3A-024). The server's confirm reads the same rule (R5-003).
  return reasonOf(step) && !('later' in step) && step.choice !== 'none' ? 'no_room' : 'save';
}

function noRoomLine(reason: string, t: { xPlanNoRoomInPhase: string; xPlanNoRoomOutsideHours: string; xPlanNoRoom: string }): string {
  return reason === 'no_free_time_in_phase' ? t.xPlanNoRoomInPhase : reason === 'outside_work_hours' ? t.xPlanNoRoomOutsideHours : t.xPlanNoRoom;
}

/** The step's words, from the plan the times belong to; null when the screen cannot name it. */
function titleIn(plan: GoalPlan | null, stepId: string): string | null {
  const title = plan?.steps.find(step => step.stepId === stepId)?.title?.trim();
  return title ? title : null;
}

function TimesStep({ flow, times, plan }: { flow: Flow; times: GoalPlanTimes; plan: GoalPlan | null }) {
  const { t, p, lang } = useApp();
  const slotLine = useSlotLine();
  const weeklyLine = useWeeklyLine();
  const startOf = useHabitStarts(times, plan);
  const [toggled, setChanging] = React.useState<string | null>(null);
  // «غيّر كل الأوقات» (M4a R005): open while the person picks; «طبّق» closes it.
  const [allOpen, setAllOpen] = React.useState(false);
  const placeable = times.steps.some(step => !laterOf(step));
  // The steps the last batch found no room for, by name: «ما لقيت وقت لـ…، صارت بلا وقت».
  const unplacedTitles = (flow.state.unplaced ?? []).map(stepId => titleIn(plan, stepId)).filter((title): title is string => title !== null);
  const [lastChosen, setLastChosen] = React.useState<string | null>(null);
  const busy = flow.state.busy;
  // A refusal that came back with new times opens the new choices for the
  // step that was being changed: «جبتلك أوقات جديدة» should show them.
  const error = flow.state.error;
  const reopened = error instanceof GoalPlanRefusedError && error.detail.times ? lastChosen : null;
  const changing = toggled ?? reopened;
  const choose = (stepId: string, choice: Parameters<Flow['choose']>[1]) => {
    setLastChosen(stepId);
    setChanging(null);
    flow.choose(stepId, choice);
  };

  return <View style={{ gap: 12 }}>
    <StepHeading>{t.xPlanTimesTitle}</StepHeading>
    {placeable ? <ProductActions>
      <Pill testID="plan-times-all" label={t.yAllTimesOpen} kind="outline" expanded={allOpen} disabled={busy}
        onPress={() => setAllOpen(open => !open)} />
    </ProductActions> : null}
    {allOpen ? <AllTimesSheet busy={busy} onApply={(preference) => { setAllOpen(false); setChanging(null); flow.batch(preference); }} /> : null}
    <LiveRegion>
      {unplacedTitles.length > 0 ? <Txt role="supporting" color={p.wm} testID="plan-times-unplaced">
        {fill(t.yUnplaced, { titles: unplacedTitles.map(isolateAuto).join(lang === 'en' ? ', ' : '، ') })}
      </Txt> : null}
    </LiveRegion>
    {times.steps.map(step => {
      const name = titleIn(plan, step.stepId);
      const later = laterOf(step);
      const slot = slotOf(step);
      const weekly = weeklyOf(step);
      const reason = reasonOf(step);
      const alternatives = alternativesOf(step);
      return <Card key={step.stepId} testID={`plan-times-step-${step.stepId}`} style={{ gap: 8 }}>
        {name ? <Txt role="body" weight={700}>{name}</Txt> : null}
        {later ? <Txt role="supporting" color={p.mu} testID={`plan-times-later-${step.stepId}`}>{fill(t.xPlanTimesLater, { n: later.weekIndex })}</Txt> : <>
          {slot ? <Txt testID={`plan-times-slot-${step.stepId}`}>{slotLine(slot)}</Txt> : null}
          {weekly ? <Txt testID={`plan-times-weekly-${step.stepId}`}>{weeklyLine(weekly, startOf(step.stepId))}</Txt> : null}
          {!slot && !weekly && reason ? <Txt role="supporting" color={p.wm} testID={`plan-times-reason-${step.stepId}`}>{noRoomLine(reason, t)}</Txt> : null}
          {!slot && !weekly && !reason ? <Txt role="supporting" color={p.mu} testID={`plan-times-none-chosen-${step.stepId}`}>{t.xPlanTimesNone}</Txt> : null}
          <ProductActions>
            {alternatives.length > 0 ? <Pill testID={`plan-times-change-${step.stepId}`} label={t.xPlanTimesChange} kind="outline" expanded={changing === step.stepId}
              disabled={busy} onPress={() => setChanging(current => current === step.stepId ? null : step.stepId)} /> : null}
            <Pill testID={`plan-times-none-${step.stepId}`} label={t.xPlanTimesNone} kind="outline" disabled={busy}
              onPress={() => choose(step.stepId, { none: true })} />
          </ProductActions>
          {changing === step.stepId ? <View style={{ gap: 8 }} accessibilityLabel={t.xPlanTimesAlternatives}>
            <Txt role="metadata" color={p.mu}>{t.xPlanTimesAlternatives}</Txt>
            {alternatives.map((alternative, index) => <Pill key={index} testID={`plan-times-alt-${step.stepId}-${index + 1}`}
              label={isSlot(alternative) ? slotLine(alternative) : weeklyLine(alternative, startOf(step.stepId))} kind="outline" disabled={busy}
              onPress={() => choose(step.stepId, isSlot(alternative) ? { slot: alternative } : { weekly: alternative })} />)}
          </View> : null}
        </>}
      </Card>;
    })}
    <ProductActions>
      <Pill testID="plan-times-next" label={t.xPlanTimesNext} disabled={busy} onPress={flow.toConfirm} />
    </ProductActions>
  </View>;
}

/* ── before the confirm, and the confirm ───────────────────────────── */

function ConfirmStep({ flow, times, plan }: { flow: Flow; times: GoalPlanTimes; plan: GoalPlan | null }) {
  const { t, tr, p } = useApp();
  const slotLine = useSlotLine();
  const weeklyLine = useWeeklyLine();
  const startOf = useHabitStarts(times, plan);
  const saved = times.steps.filter(step => stepOutcome(step) === 'save');
  const stayed = times.steps.filter(step => stepOutcome(step) !== 'save');
  const removed = plan?.removedSteps ?? [];
  const busy = flow.state.busy;
  // Nothing is confirmed that the person cannot read: every step on this
  // screen must be named (inspection A-001: a later week came back unnamed).
  const unnamed = times.steps.some(step => titleIn(plan, step.stepId) === null);
  // A plan whose steps all wait for later weeks, or have no room yet, is still
  // confirmed as a plan: its later weeks are what the confirm keeps (A-007).
  const label = saved.length > 0 ? tr('xPlanConfirmN', { n: saved.length }) : t.xPlanConfirmPlan;
  return <View style={{ gap: 12 }}>
    {saved.length > 0 ? <Card testID="plan-will-save" style={{ gap: 8 }}>
      <StepHeading>{t.xPlanWillSave}</StepHeading>
      {saved.map(step => {
        const slot = slotOf(step);
        const weekly = weeklyOf(step);
        return <View key={step.stepId} testID={`plan-will-save-${step.stepId}`} style={{ gap: 2 }}>
          <Txt role="body">{titleIn(plan, step.stepId) ?? ''}</Txt>
          <Txt role="metadata" color={p.mu}>{slot ? slotLine(slot) : weekly ? weeklyLine(weekly, startOf(step.stepId)) : t.xPlanTimesNone}</Txt>
        </View>;
      })}
    </Card> : null}
    {stayed.length + removed.length > 0 ? <Card testID="plan-will-stay" style={{ gap: 8 }}>
      {saved.length > 0 ? <Txt role="section">{t.xPlanWillStay}</Txt> : <StepHeading>{t.xPlanWillStay}</StepHeading>}
      {stayed.map(step => {
        const later = laterOf(step);
        return <View key={step.stepId} testID={`plan-will-stay-${step.stepId}`} style={{ gap: 2 }}>
          <Txt role="body">{titleIn(plan, step.stepId) ?? ''}</Txt>
          <Txt role="metadata" color={p.mu}>{later ? fill(t.xPlanStayLaterWeek, { n: later.weekIndex }) : t.xPlanStayNoRoom}</Txt>
        </View>;
      })}
      {removed.map(step => <View key={step.stepId} testID={`plan-will-stay-${step.stepId}`} style={{ gap: 2 }}>
        <Txt role="body">{step.title}</Txt>
        <Txt role="metadata" color={p.mu}>{t.xPlanStayRemoved}</Txt>
      </View>)}
    </Card> : null}
    <ProductActions>
      <Pill testID="plan-confirm" label={label} disabled={busy || unnamed || times.steps.length === 0} onPress={flow.confirm} />
      <Pill testID="plan-back-times" label={t.xPlanBackToPlan} kind="outline" disabled={busy} onPress={flow.backToTimes} />
    </ProductActions>
  </View>;
}

function ResultStep({ result, onOpenToday }: { result: import('../../api/schemas/goalPlan').GoalPlanConfirmResult; onOpenToday: () => void }) {
  const { t, tr, p } = useApp();
  const slotLine = useSlotLine();
  const weeklyLine = useWeeklyLine();
  return <Card testID="plan-result" style={{ gap: 10 }}>
    <StepHeading color={p.success}>{t.xPlanSavedTitle}</StepHeading>
    <Txt role="supporting">{tr('xPlanSavedBodyN', { n: result.saved.length })}</Txt>
    {result.saved.map(item => <View key={item.stepId} testID={`plan-result-saved-${item.stepId}`} style={{ gap: 2 }}>
      <Txt role="body">{item.title}</Txt>
      <Txt role="metadata" color={p.mu}>{item.when.kind === 'slot' ? slotLine(item.when)
        : item.when.kind === 'weekly' ? weeklyLine(item.when) : t.xPlanTimesNone}</Txt>
    </View>)}
    {result.stayed.length > 0 ? <>
      <Txt role="label">{t.xPlanStayedTitle}</Txt>
      {result.stayed.map(item => <View key={item.stepId} testID={`plan-result-stayed-${item.stepId}`} style={{ gap: 2 }}>
        <Txt role="body">{item.title}</Txt>
        <Txt role="metadata" color={p.mu}>{item.why.kind === 'later_week' ? fill(t.xPlanStayLaterWeek, { n: item.why.weekIndex })
          : item.why.kind === 'removed' ? t.xPlanStayRemoved : t.xPlanStayNoRoom}</Txt>
      </View>)}
    </> : null}
    <ProductActions><Pill testID="plan-open-today" label={t.xPlanOpenToday} kind="outline" onPress={onOpenToday} /></ProductActions>
  </Card>;
}

/* ── could not ─────────────────────────────────────────────────────── */

const FLOW_RECOVERIES: ReadonlySet<PlanRecovery> = new Set(['retry', 'template', 'new_plan', 'show_latest', 'new_times', 'pick_another', 'when_online']);

function FailureCard({ flow, onRecover, hostRecoveries }: {
  flow: Flow;
  onRecover: (recovery: PlanRecovery, detail: { currentGoalId?: string | undefined }) => void;
  hostRecoveries: readonly PlanRecovery[];
}) {
  const { t, p, lang, rtl } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  // The answer belongs to the failure it answers: a new failure starts closed.
  const [answer, setAnswer] = React.useState<{ to: unknown; text: string } | null>(null);
  const error = flow.state.error;
  const failure = planFailureOf(error, t);
  const answering = answer && answer.to === error ? answer.text : null;
  const setAnswering = (text: string) => setAnswer({ to: error, text });
  if (!failure) return null;
  const detail = error instanceof GoalPlanRefusedError ? error.detail : {};
  const statement = flow.state.statement;
  const act = (recovery: PlanRecovery) => {
    switch (recovery) {
      case 'retry': case 'when_online': return flow.retry();
      case 'template': return flow.generate('template');
      case 'new_plan': return flow.regenerate();
      // The current plan or times already came back with the refusal and are
      // on screen; without them, read the plan again.
      case 'show_latest': return detail.plan || detail.times ? flow.dismissError() : flow.showLatest();
      // The new times came with the refusal and are on screen; if they could
      // not be drawn, read the plan again (R5-004).
      case 'new_times': return detail.times ? flow.dismissError() : flow.showLatest();
      case 'pick_another': return flow.dismissError();
      // A statement entry is answered here, in the same words: the question
      // stays on screen and the answer goes back with what was said.
      case 'answer': return statement !== null ? setAnswering('') : onRecover(recovery, {});
      case 'rephrase': return statement !== null ? setAnswering(statement) : onRecover(recovery, {});
      default: return onRecover(recovery, { currentGoalId: detail.currentGoalId });
    }
  };
  const sendAnswer = () => {
    if (answering === null || !answering.trim() || statement === null) return;
    const said = failure.reason === 'goal_too_vague' ? `${statement}\n${answering.trim()}` : answering.trim();
    flow.fromStatement(said, lang);
  };
  // Answering or rephrasing goes back through the statement's summary, so it
  // is offered only before a goal exists; after that the simple plan is.
  const canRestate = statement !== null && flow.state.goalId === null;
  // The simple plan is made for a goal; before the statement became one it has
  // nothing to be made for (inspection A2-005).
  const offered = failure.recoveries.filter(recovery => recovery === 'template' ? flow.state.goalId !== null
    : FLOW_RECOVERIES.has(recovery)
      || ((recovery === 'answer' || recovery === 'rephrase') ? canRestate : hostRecoveries.includes(recovery)));
  const [first, second] = offered;
  return <Card testID="plan-failure" style={{ gap: 10, borderColor: p.wm }}>
    <Txt role="supporting" color={p.wm}>{failure.message}</Txt>
    {failure.question ? <Txt role="body" testID="plan-failure-question">{failure.question}</Txt> : null}
    {answering !== null ? <>
      <TextInput
        testID="plan-failure-answer"
        accessibilityLabel={failure.question ?? t.xPlanSummaryInput}
        value={answering}
        onChangeText={setAnswering}
        maxLength={2000}
        multiline
        autoFocus
        style={{ color: p.tx, backgroundColor: p.bg, padding: 12, minHeight: 56, borderRadius: 14, fontSize: 17, textAlign: rtl ? 'right' : 'left' }}
      />
      <ProductActions>
        <Pill testID="plan-failure-answer-send" label={t.xPlanSummaryConfirm} disabled={flow.state.busy || !answering.trim()} onPress={sendAnswer} />
      </ProductActions>
    </> : first ? <View style={{ flexDirection: stacked ? 'column' : 'row', flexWrap: 'wrap', gap: 10 }}>
      <Pill testID="plan-failure-action" label={recoveryLabel(first, t)} disabled={flow.state.busy} onPress={() => act(first)} />
      {second ? <Pill testID="plan-failure-action-2" label={recoveryLabel(second, t)} kind="outline" disabled={flow.state.busy} onPress={() => act(second)} /> : null}
    </View> : null}
  </Card>;
}
