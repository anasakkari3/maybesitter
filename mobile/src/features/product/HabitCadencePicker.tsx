import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';
import { ProductActions } from '../../ui/product';
import { formatNumber } from '../../i18n/format';
import type { NewHabitInput } from '../../api/schemas/habits';

export type HabitCadence = NewHabitInput['cadence'];

/**
 * How often a habit repeats, in either shape the server's cadence has always
 * had (audit 2026-10-03, #12).
 *
 * The creator used to offer 1×, 3× and 5× a week and nothing else, so
 * «بيلاتيس الثلاثاء والخميس» could not be said. `weekly_count` takes any count
 * from 1 to 7 (the days are the planner's to choose) and `weekdays` names the
 * days (0 = Sunday, the contract's numbering and the order of `t.days`).
 *
 * One draft holds both, so taking the last picked day off falls back to the
 * count the person had rather than to an empty, unsaveable cadence.
 */
export interface CadenceDraft {
  readonly mode: 'count' | 'days';
  readonly count: number;
  readonly weekdays: readonly number[];
}

export const DEFAULT_CADENCE_DRAFT: CadenceDraft = Object.freeze({ mode: 'count', count: 3, weekdays: Object.freeze([]) });

export const WEEKLY_COUNTS = [1, 2, 3, 4, 5, 6, 7] as const;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export function chooseCount(_draft: CadenceDraft, count: number): CadenceDraft {
  return { mode: 'count', count, weekdays: [] };
}

export function toggleWeekday(draft: CadenceDraft, day: number): CadenceDraft {
  const current = draft.mode === 'days' ? draft.weekdays : [];
  const next = current.includes(day) ? current.filter(value => value !== day) : [...current, day].sort((a, b) => a - b);
  return next.length > 0 ? { mode: 'days', count: draft.count, weekdays: next } : { mode: 'count', count: draft.count, weekdays: [] };
}

/** What the server is sent. */
export function cadenceOf(draft: CadenceDraft): HabitCadence {
  return draft.mode === 'days'
    ? { kind: 'weekdays', weekdays: [...draft.weekdays] }
    : { kind: 'weekly_count', count: draft.count };
}

/** Occurrences one full week asks for — the server's `cadenceOccurrencesPerPeriod`. */
export function perWeekOf(draft: CadenceDraft): number {
  return draft.mode === 'days' ? draft.weekdays.length : draft.count;
}

/** A saved cadence, in words: «3× بالأسبوع», or «الثلاثاء · الخميس». */
export function describeCadence(cadence: HabitCadence, t: { xTimesPerWeek: string; days: readonly string[] }, lang: string): string {
  if (cadence.kind === 'weekly_count') {
    return t.xTimesPerWeek.replace('{count}', formatNumber(cadence.count, { locale: lang as never }));
  }
  return cadence.weekdays.map(day => t.days[day] ?? String(day)).join(' · ');
}

export function HabitCadencePicker({ value, onChange, testIDPrefix }: {
  value: CadenceDraft;
  onChange: (next: CadenceDraft) => void;
  /** `habit` on the creator, `goal-<nodeId>` on a goal step. */
  testIDPrefix: string;
}) {
  const { t, p, lang } = useApp();
  return (
    <View style={{ gap: 10 }}>
      <View accessibilityRole="radiogroup" accessibilityLabel={t.xCadence}>
        <Txt role="supporting" color={p.mu}>{t.xCountPerWeek}</Txt>
        <ProductActions>
          {WEEKLY_COUNTS.map(count => {
            const checked = value.mode === 'count' && value.count === count;
            const label = t.xTimesPerWeek.replace('{count}', formatNumber(count, { locale: lang }));
            return (
              <Btn
                key={count}
                testID={`${testIDPrefix}-count-${count}`}
                label={label}
                accessibilityRole="radio"
                accessibilityState={{ checked }}
                onPress={() => onChange(chooseCount(value, count))}
                style={chipStyle(checked, p)}
              >
                <Txt size={15} latin weight={600} color={checked ? p.onAccent : p.tx} align="center">{`${count}×`}</Txt>
              </Btn>
            );
          })}
        </ProductActions>
      </View>
      <Txt role="supporting" color={p.mu}>{t.xCadenceOrDays}</Txt>
      <View accessibilityLabel={t.xCadenceOrDays}>
        <ProductActions>
          {WEEKDAYS.map(day => {
            const checked = value.mode === 'days' && value.weekdays.includes(day);
            return (
              <Btn
                key={day}
                testID={`${testIDPrefix}-day-${day}`}
                // The full name for a screen reader; the short one on the chip.
                label={t.days[day]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                onPress={() => onChange(toggleWeekday(value, day))}
                style={chipStyle(checked, p)}
              >
                <Txt size={15} weight={600} color={checked ? p.onAccent : p.tx} align="center">{t.daysShort[day]}</Txt>
              </Btn>
            );
          })}
        </ProductActions>
      </View>
    </View>
  );
}

/** The Pill's accent and outline looks, kept here so the chip can carry a checked state. */
function chipStyle(checked: boolean, p: ReturnType<typeof useApp>['p']) {
  return {
    backgroundColor: checked ? p.ac : p.sf,
    borderRadius: 999,
    borderWidth: checked ? 0 : 1,
    borderColor: p.ln,
    minHeight: 48,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };
}
