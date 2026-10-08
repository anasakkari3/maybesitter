import React from 'react';
import { View } from 'react-native';
import type { GoalPlanBatchPreference } from '../../api/endpoints/goalPlan';
import { dayKey, formatRelativeDay, shiftDayKey } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { useApp } from '../../state/AppContext';
import { Disclosure } from '../../ui/Disclosure';
import { Btn, Card, Pill, Txt } from '../../ui/primitives';
import { ProductActions } from '../../ui/product';
import { instantForLocalDateTime } from '../capture/localInstant';

/**
 * «غيّر كل الأوقات» (M4a R005, condition 23): one small sheet that moves every
 * placeable step at once — to a part of the day, from a first day, or all
 * without a time — and «طبّق» sends one request.
 *
 * The first day is today, tomorrow, or a day picked up to today + 14: the
 * server's own bound (M4A-R7-004), so a day the server would refuse is never
 * offered. Why the steps land where they land is behind the arrow. Nothing is
 * saved here: the per-step «غيّر الوقت» stays, and «احفظ» is still the only
 * save.
 */

const PARTS = ['morning', 'afternoon', 'evening'] as const;
type Part = typeof PARTS[number];
type Start = 'today' | 'tomorrow' | 'pick';

/** The furthest first day the server takes (today + 14). */
export const START_FROM_MAX_DAYS = 14;

export function AllTimesSheet({ busy, onApply }: { busy: boolean; onApply: (preference: GoalPlanBatchPreference) => void }) {
  const { t, p, lang } = useApp();
  const timeZone = useTimeZone();
  const [part, setPart] = React.useState<Part | null>(null);
  const [start, setStart] = React.useState<Start | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);
  const [noTime, setNoTime] = React.useState(false);
  const today = dayKey(new Date(), timeZone);
  const days = Array.from({ length: START_FROM_MAX_DAYS + 1 }, (_, index) => shiftDayKey(today, index));

  const startFrom = start === 'today' ? today : start === 'tomorrow' ? shiftDayKey(today, 1) : start === 'pick' ? picked : null;
  const ready = noTime || part !== null || startFrom !== null;
  const partLabel = (value: Part) => value === 'morning' ? t.yPartMorning : value === 'afternoon' ? t.yPartAfternoon : t.yPartEvening;
  const startLabel = (value: Start) => value === 'today' ? t.yStartToday : value === 'tomorrow' ? t.yStartTomorrow : t.yStartPick;
  const dayLabel = (key: string) => {
    const at = instantForLocalDateTime(`${key}T12:00`, timeZone);
    return at ? formatRelativeDay(at, { locale: lang, timeZone }) : key;
  };

  const apply = () => {
    if (!ready || busy) return;
    onApply(noTime ? { noTime: true } : {
      ...(part ? { partOfDay: part } : {}),
      ...(startFrom ? { startFrom } : {}),
    });
  };

  return (
    <Card testID="plan-times-all-sheet" style={{ gap: 12 }}>
      <Txt role="section" size={16} weight={700}>{t.yAllTimesTitle}</Txt>
      <Disclosure id="plan-times-all" body={t.yAllTimesWhy} label={t.yAllTimesTitle} />
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {PARTS.map((value) => (
          <Choice key={value} testID={`plan-times-all-part-${value}`} label={partLabel(value)} selected={!noTime && part === value} disabled={busy}
            onPress={() => { setNoTime(false); setPart(current => current === value ? null : value); }} />
        ))}
      </View>
      <Txt role="supporting" color={p.mu}>{t.yStartFrom}</Txt>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(['today', 'tomorrow', 'pick'] as const).map((value) => (
          <Choice key={value} testID={`plan-times-all-start-${value}`} label={startLabel(value)} selected={!noTime && start === value} disabled={busy}
            onPress={() => { setNoTime(false); setStart(current => current === value ? null : value); }} />
        ))}
      </View>
      {start === 'pick' && !noTime ? (
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {days.map((key) => (
            <Choice key={key} testID={`plan-times-all-day-${key}`} label={dayLabel(key)} selected={picked === key} disabled={busy}
              onPress={() => setPicked(key)} />
          ))}
        </View>
      ) : null}
      <Choice testID="plan-times-all-none" label={t.yAllNoTime} selected={noTime} disabled={busy}
        onPress={() => { setNoTime(current => !current); setPart(null); setStart(null); setPicked(null); }} />
      <ProductActions>
        <Pill testID="plan-times-all-apply" label={t.yApply} disabled={busy || !ready} onPress={apply} />
      </ProductActions>
    </Card>
  );
}

function Choice({ testID, label, selected, disabled, onPress }: { testID: string; label: string; selected: boolean; disabled: boolean; onPress: () => void }) {
  const { p } = useApp();
  return (
    <Btn testID={testID} label={label} accessibilityRole="radio" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} scaleTo={0.97}
      style={{ minHeight: 44, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: selected ? p.ac : p.lnStrong, backgroundColor: selected ? p.acs : p.sf2, paddingVertical: 9, paddingHorizontal: 16 }}>
      <Txt size={14} weight={selected ? 700 : 500} color={selected ? p.acd : p.tx}>{label}</Txt>
    </Btn>
  );
}
