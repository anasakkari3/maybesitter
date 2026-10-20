import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useSaveSubjectiveEnergy, useUid } from '../../api/queries';
import type { DailyPlan } from '../../api/schemas/plan';
import type { NextStepEnergy, PlanEffect, ReadinessApplied } from '../../api/schemas/m5b';
import { Btn, Card, Txt } from '../../ui/primitives';
import { LiveRegion } from '../../ui/liveRegion';
import { loadEnergyAskHiddenToday, saveEnergyAskHiddenToday } from '../../lib/deviceSettings/m5bEnergyAsk';

/**
 * Energy where it acts (PLAN-M5b-1 R4.2, R4.3): the 1–5 question on Plan and
 * Today, and the one sentence that says what a reading did.
 *
 * Every line is chosen from what the server says it applied — the plan's
 * `readinessApplied`, the readiness `planEffect`, the next step's `energy` —
 * never from a reading this screen holds, so a sentence can only describe what
 * actually happened. Off or unknown capability draws none of it.
 */
type Level = 1 | 2 | 3 | 4 | 5;
const LEVELS: readonly Level[] = [1, 2, 3, 4, 5];
type Tr = (key: string, values?: Record<string, unknown>) => string;

/** What a plan's buffer came from, in one sentence; null when there is nothing true to say. */
export function effectSentence(tr: Tr, effect: { source: 'check_in' | 'health' | 'none'; energy: Level | null; minutes: number }): string | null {
  if (effect.source === 'check_in' && effect.energy !== null) {
    return effect.minutes > 0
      ? tr('m5bEnergyLow', { energy: effect.energy, minutes: effect.minutes })
      : tr('m5bEnergyNoEffect', { energy: effect.energy });
  }
  if (effect.source === 'health') {
    return effect.minutes > 0 ? tr('m5bEnergyHealthLow', { minutes: effect.minutes }) : tr('m5bEnergyHealthNoEffect');
  }
  if (effect.source === 'none') return tr('m5bEnergyNone');
  return null;
}

/**
 * The 1–5 row. A single choice, so a radio group: a screen reader says only
 * one may be picked. 44-pt targets, the level in Latin digits, the chosen one
 * announced as selected, not only coloured.
 */
function EnergyScale({ prefix, label, selected, busy, onPick }: {
  prefix: string;
  label: string;
  selected: Level | null;
  busy: boolean;
  onPick: (level: Level) => void;
}) {
  const { tr, p } = useApp();
  return (
    <View
      testID={`${prefix}-question`}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ flexDirection: 'row', gap: 8 }}
    >
      {LEVELS.map(level => {
        const active = selected === level;
        return (
          <Btn
            key={level}
            testID={`${prefix}-${level}`}
            label={tr('m5bEnergyLevelA11y', { energy: level })}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            disabled={busy}
            onPress={() => onPick(level)}
            style={{
              flex: 1, minHeight: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
              backgroundColor: active ? p.ac : p.bg, borderWidth: 1, borderColor: active ? p.ac : p.ln,
            }}
          >
            <Txt size={15} weight={600} color={active ? p.onAccent : p.tx} latin>{level}</Txt>
          </Btn>
        );
      })}
    </View>
  );
}

function ChangeLink({ testID, onPress, expanded }: { testID: string; onPress: () => void; expanded: boolean }) {
  const { t, p } = useApp();
  return (
    <Btn
      testID={testID}
      label={t.m5bEnergyChange}
      accessibilityState={{ expanded }}
      onPress={onPress}
      hitSlop={8}
      scaleTo={0.97}
      style={{ minHeight: 44, justifyContent: 'center', alignItems: 'flex-start' }}
    >
      <Txt size={14} color={p.ac}>{t.m5bEnergyChange}</Txt>
    </Btn>
  );
}

/** Saves one check-in, now. The mutation already refetches readiness, the plan and the next step. */
function useCheckIn() {
  const save = useSaveSubjectiveEnergy();
  const [failed, setFailed] = useState(false);
  const pick = async (energy: Level): Promise<boolean> => {
    setFailed(false);
    try {
      await save.mutateAsync({ energy, observedAt: new Date().toISOString() });
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  };
  return { pick, busy: save.isPending, failed };
}

function SaveFailed({ testID }: { testID: string }) {
  const { t, p } = useApp();
  return <Txt size={13} color={p.wm} testID={testID}>{t.readinessSaveFailed}</Txt>;
}

/** The empty Plan: an optional question above «ابني خطة اليوم». Never required to build. */
export function PlanEnergyAsk() {
  const { t, p } = useApp();
  const checkIn = useCheckIn();
  const [picked, setPicked] = useState<Level | null>(null);
  return (
    <View style={{ gap: 8, alignSelf: 'stretch' }}>
      <Txt size={15} weight={600}>{t.m5bEnergyAskTitle}</Txt>
      <Txt size={13} color={p.mu} lh={1.5}>{t.m5bEnergyAskSub}</Txt>
      <EnergyScale
        prefix="m5b-plan-energy"
        label={t.m5bEnergyAskTitle}
        selected={picked}
        busy={checkIn.busy}
        onPick={level => void checkIn.pick(level).then(ok => { if (ok) setPicked(level); })}
      />
      {checkIn.failed ? <SaveFailed testID="m5b-plan-energy-failed" /> : null}
    </View>
  );
}

/**
 * A built plan: what its reading did, «غيّرها», and the notice when the
 * reading it was solved with is no longer the one that applies.
 */
export function PlanEnergy({ plan, readOnly, capReached }: { plan: DailyPlan; readOnly: boolean; capReached: boolean }) {
  const { t, tr, p } = useApp();
  const checkIn = useCheckIn();
  const [open, setOpen] = useState(false);
  const applied: ReadinessApplied | null = plan.readinessApplied ?? null;
  const changed = plan.basisChanged === true;
  // An unknown snapshot (null) says nothing about its reading, and a plan
  // solved with none that now has one would contradict the notice (M5B1-006).
  const sentence = applied === null || (applied.source === 'none' && changed)
    ? null
    : effectSentence(tr as Tr, { source: applied.source, energy: applied.energy, minutes: applied.bufferMinutesAdded });

  return (
    <View style={{ gap: 10 }}>
      {changed ? (
        <Card pad={16} testID={capReached ? 'm5b-plan-basis-changed-no-rebuild' : 'm5b-plan-basis-changed'}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.wm, marginTop: 8 }} />
            <Txt size={14} lh={1.5} style={{ flex: 1 }}>
              {capReached ? t.m5bPlanBasisChangedNoRebuild : t.m5bPlanBasisChanged}
            </Txt>
          </View>
        </Card>
      ) : null}
      <Card pad={16} style={{ gap: 8 }}>
        {sentence ? <Txt size={14} lh={1.5} testID="m5b-plan-energy-effect">{sentence}</Txt> : null}
        {readOnly ? null : <ChangeLink testID="m5b-plan-energy-change" expanded={open} onPress={() => setOpen(!open)} />}
        {open && !readOnly ? (
          <EnergyScale
            prefix="m5b-plan-energy"
            label={t.m5bEnergyAskTitle}
            selected={null}
            busy={checkIn.busy}
            onPick={level => void checkIn.pick(level).then(ok => { if (ok) setOpen(false); })}
          />
        ) : null}
        {checkIn.failed ? <SaveFailed testID="m5b-plan-energy-failed" /> : null}
      </Card>
    </View>
  );
}

/** The readiness status card's one sentence, in place of the band/source/freshness labels. */
export function ReadinessEffect({ effect }: { effect: PlanEffect }) {
  const { tr, p } = useApp();
  if (effect.source === 'none') {
    return effect.staleReading
      ? <Txt size={14} lh={1.5} color={p.mu} testID="m5b-readiness-stale">{tr('m5bEnergyStale')}</Txt>
      : <Txt size={14} lh={1.5} color={p.mu} testID="m5b-readiness-never">{tr('m5bEnergyNever')}</Txt>;
  }
  return (
    <Txt size={14} lh={1.5} testID="m5b-readiness-effect">
      {effectSentence(tr as Tr, { source: effect.source, energy: effect.energy, minutes: effect.bufferMinutes })}
    </Txt>
  );
}

/**
 * Today, under the next-step card: the reading and what it did to the pick,
 * or — with no fresh reading — an optional question that can be put away for
 * the rest of the local day (M5B-018).
 */
export function TodayEnergy({ energy }: { energy: NextStepEnergy }) {
  const { t, tr, p } = useApp();
  const uid = useUid();
  const checkIn = useCheckIn();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<Level | null>(null);
  // Per account: another account on this phone has its own answer. Null
  // until read; the question waits for it rather than flash and vanish.
  const [hidden, setHidden] = useState<{ uid: string; value: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    void loadEnergyAskHiddenToday(uid).then(value => { if (alive) setHidden({ uid, value }); });
    return () => { alive = false; };
  }, [uid]);
  const hiddenToday = hidden?.uid === uid ? hidden.value : null;

  const pick = (level: Level) => void checkIn.pick(level).then(ok => {
    if (!ok) return;
    setSaved(level);
    setOpen(false);
  });
  const hide = () => {
    setHidden({ uid, value: true });
    void saveEnergyAskHiddenToday(uid).then(ok => { if (!ok) setHidden({ uid, value: false }); });
  };

  const fresh = energy.source !== 'none';
  const line = energy.source === 'check_in' && energy.level !== null
    ? <Txt size={14} lh={1.5}>{tr('m5bEnergyToday', { energy: energy.level })}</Txt>
    : energy.source === 'health'
      ? <Txt size={14} lh={1.5} testID="m5b-today-energy-health">{tr('m5bEnergyTodayHealth', { band: energy.band ?? 'unknown' })}</Txt>
      : null;

  return (
    <View style={{ gap: 8, paddingHorizontal: 4 }}>
      {fresh ? (
        <View testID="m5b-today-energy" style={{ gap: 4 }}>
          {line}
          {energy.changedPick ? (
            <Txt size={13} color={p.mu} lh={1.5} testID="m5b-today-energy-lighter">{t.m5bEnergyLighter}</Txt>
          ) : null}
          <ChangeLink testID="m5b-today-energy-change" expanded={open} onPress={() => setOpen(!open)} />
          {open ? (
            <EnergyScale prefix="m5b-today-energy" label={t.m5bEnergyAskNow} selected={null} busy={checkIn.busy} onPick={pick} />
          ) : null}
        </View>
      ) : hiddenToday === false && saved === null ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 10 }}>
            <Txt size={14} weight={600}>{t.m5bEnergyAskNow}</Txt>
            <Btn
              testID="m5b-today-energy-hide"
              label={t.m5bEnergyHideTodayA11y}
              onPress={hide}
              hitSlop={8}
              scaleTo={0.97}
              style={{ minHeight: 44, justifyContent: 'center' }}
            >
              <Txt size={14} color={p.ac}>{t.m5bEnergyHideToday}</Txt>
            </Btn>
          </View>
          <EnergyScale prefix="m5b-today-energy" label={t.m5bEnergyAskNow} selected={null} busy={checkIn.busy} onPick={pick} />
        </View>
      ) : null}
      {checkIn.failed ? <SaveFailed testID="m5b-today-energy-failed" /> : null}
      <LiveRegion testID="m5b-today-energy-saved">
        {saved !== null ? <Txt size={13} color={p.mu}>{tr('m5bEnergyToday', { energy: saved })}</Txt> : null}
      </LiveRegion>
    </View>
  );
}
