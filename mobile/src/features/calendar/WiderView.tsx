import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { CIVIL_ZONE, civilDate, formatDate } from '../../i18n/format';
import { fill } from '../../i18n/strings';
import { useLayoutMode } from '../../theme/textScale';
import { Btn, Txt } from '../../ui/primitives';
import { ReferenceIcon } from '../../ui/referenceIcons';
import { useReferencePalette } from '../../ui/referenceDesign';
import { gapLength } from './FreeTimeRows';
import type { DayFree } from './freeReadiness';

/**
 * «شوف أبعد»: four weeks from today, opened on demand (M4a R004, owner D4).
 *
 * A cell says its day, how many commitments it holds, and — when every
 * source vouches for the whole day — a light bar for how free it is. The bar
 * is decoration; the cell's accessible label says the free time in words.
 * Where Google Calendar is connected but its window stops (14 days, or
 * earlier when its read was cut), the cells past it draw no bar and say so,
 * and one note says it once, at the first such cell.
 *
 * Tapping a day closes the view and opens that day on the Plan tab.
 */

export interface WiderCell {
  readonly key: string;
  readonly count: number;
  readonly free: DayFree;
  /** Google is connected and its window does not cover this day. */
  readonly googleUncovered: boolean;
  /** The day's waking minutes, for the bar's scale. */
  readonly windowMinutes: number;
}

export function WiderView({ cells, todayKey, selectedKey, googleNote, onPick, onClose }: {
  cells: readonly WiderCell[];
  todayKey: string;
  selectedKey: string;
  /** Where the Google note goes, and which words it uses; null without Google or when every cell is covered. */
  googleNote: { index: number; normal: boolean } | null;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const { t, lang } = useApp();
  const p = useReferencePalette();
  const stacked = useLayoutMode() !== 'normal';
  const columns = stacked ? 4 : 7;
  const rows: WiderCell[][] = [];
  for (let index = 0; index < cells.length; index += columns) rows.push(cells.slice(index, index + columns));
  const noteRow = googleNote ? Math.floor(googleNote.index / columns) : -1;

  return (
    <View testID="calendar-wider" style={{ gap: 10, borderRadius: 20, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf, padding: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <ReferenceIcon name="calendar" size={18} color={p.acd} />
        <Txt role="section" size={16} weight={700} color={p.tx} style={{ flex: 1 }}>{t.yWiderTitle}</Txt>
        {/* The bar's key, as the strip keys its dots: green is free time. */}
        <View accessible={false} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 14, height: 4, borderRadius: 2, backgroundColor: p.success }} />
          <Txt size={13} color={p.mu}>{t.yFilterFree}</Txt>
        </View>
        <Btn testID="calendar-wider-close" label={t.close} onPress={onClose} hitSlop={8} scaleTo={0.94}
          style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf2 }}>
          <ReferenceIcon name="close" size={18} color={p.tx} />
        </Btn>
      </View>
      {/* Each column is one weekday (rows start from today), so its name sits
          above it once; a cell then needs only its date. */}
      {!stacked && cells.length > 0 ? (
        <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', gap: 6 }}>
          {cells.slice(0, columns).map((cell) => (
            <Txt key={cell.key} size={12} color={p.mu} align="center" lines={1} style={{ flex: 1 }}>
              {formatDate(civilDate(cell.key), 'weekdayShort', { locale: lang, timeZone: CIVIL_ZONE })}
            </Txt>
          ))}
        </View>
      ) : null}
      {rows.map((row, rowIndex) => (
        <View key={row[0]!.key} style={{ gap: 8 }}>
          {rowIndex === noteRow ? (
            <Txt size={13} color={p.mu} testID="calendar-wider-google-note">
              {googleNote!.normal ? t.yWiderGoogleNote : t.yWiderGoogleNoteFromHere}
            </Txt>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {row.map((cell) => (
              <WiderDay key={cell.key} cell={cell} isToday={cell.key === todayKey} selected={cell.key === selectedKey} onPress={() => onPick(cell.key)} />
            ))}
            {row.length < columns ? Array.from({ length: columns - row.length }, (_, index) => <View key={`pad-${index}`} style={{ flex: 1 }} />) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function WiderDay({ cell, isToday, selected, onPress }: { cell: WiderCell; isToday: boolean; selected: boolean; onPress: () => void }) {
  const { t, tr, lang } = useApp();
  const p = useReferencePalette();
  const date = civilDate(cell.key);
  const options = { locale: lang, timeZone: CIVIL_ZONE } as const;
  const dateText = formatDate(date, 'weekday', options);
  const count = tr('yWiderCount', { count: cell.count });
  const known = cell.free.state === 'full' && cell.free.totalMinutes !== null && !cell.googleUncovered;
  const label = cell.googleUncovered
    ? fill(t.yWiderCellUnknownA11y, { date: dateText, count })
    : known
      ? fill(t.yWiderCellA11y, { date: dateText, count, free: gapLength(cell.free.totalMinutes!, t, tr) })
      : [dateText, count, cell.free.state === 'loading' ? t.yFreeLoading : t.yFreeUnknown].join(', ');
  const ratio = known && cell.windowMinutes > 0 ? Math.min(1, cell.free.totalMinutes! / cell.windowMinutes) : 0;
  return (
    <Btn
      testID={`calendar-wider-day-${cell.key}`}
      label={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      scaleTo={0.94}
      style={{
        flex: 1, minWidth: 44, minHeight: 56, borderRadius: 14, paddingVertical: 6, paddingHorizontal: 2, gap: 3, alignItems: 'center',
        backgroundColor: selected ? p.sf2 : p.bg, borderWidth: 1, borderColor: selected ? p.heroEdge : p.ln,
      }}
    >
      <Txt size={15} weight={700} color={isToday ? p.wm : p.tx} align="center" latin lines={1}>{formatDate(date, 'dayNumber', options)}</Txt>
      <Txt size={12} color={p.mu} align="center" latin lines={1}>{cell.count > 0 ? String(cell.count) : ' '}</Txt>
      {known ? (
        <View testID={`calendar-wider-free-bar-${cell.key}`} accessible={false} style={{ alignSelf: 'stretch', marginHorizontal: 6, height: 4, borderRadius: 2, backgroundColor: p.ln, overflow: 'hidden' }}>
          <View style={{ width: `${Math.round(ratio * 100)}%`, height: 4, borderRadius: 2, backgroundColor: p.success }} />
        </View>
      ) : <View accessible={false} style={{ height: 4 }} />}
    </Btn>
  );
}
