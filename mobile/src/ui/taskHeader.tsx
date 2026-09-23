import React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useLayoutMode, type LayoutMode } from '../theme/textScale';
import { BrandMark } from './brand';
import { Btn, Txt } from './primitives';

/**
 * The header of a task — a flow that owns the whole screen (capture, review,
 * share). Round 2's shape: a pill at the start that leaves or goes back, the
 * flow's name in the middle in the muted colour, and an optional end slot for
 * one small status such as «الذكاء: مطفي». The end slot keeps its width when
 * empty so the title stays centred.
 *
 * ── Why it stops being a row ─────────────────────────────────────
 *
 * Three things on one line is a shape that only works while the line is wide
 * enough for three things. At the accessibility text sizes it is not: the
 * pill cannot shrink (it is a control with its own padding) and the end slot
 * holds 64 pt open, so the only flexible child — the name — was squeezed to
 * about a glyph, and Arabic wrapped character by character into a vertical
 * column of letters. Found on device at AX5 (F3, 2026-09-22).
 *
 * So past the first accessibility size the header stacks and each part gets
 * the whole width. This is the same rule the tab bar follows and it comes
 * from the same place — `useLayoutMode`, not a number invented here.
 */

/** A row while three things fit on a line; stacked once they cannot. */
export function taskHeaderStacks(mode: LayoutMode): boolean {
  return mode === 'xl';
}

export function TaskHeader({ pill, onPill, title, end, pillTestID }: {
  pill: string;
  onPill: () => void;
  title: string;
  end?: React.ReactNode;
  pillTestID?: string | undefined;
}) {
  const { p } = useApp();
  const insets = useSafeAreaInsets();
  const stacked = taskHeaderStacks(useLayoutMode());
  return (
    <View
      testID="task-header"
      style={{
        paddingTop: insets.top + 8,
        paddingHorizontal: 16,
        flexDirection: stacked ? 'column' : 'row',
        justifyContent: 'space-between',
        alignItems: stacked ? 'flex-start' : 'center',
        gap: 10,
      }}
    >
      <Btn label={pill} onPress={onPill} testID={pillTestID} style={{ minHeight: 44, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 16, justifyContent: 'center' }}>
        <Txt size={13} weight={600}>{pill}</Txt>
      </Btn>
      {/* Stacked, the name is on its own line: nothing may shrink it. In a
          row it is the only child that can give width back. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, ...(stacked ? {} : { flexShrink: 1 }) }}>{!stacked ? <BrandMark size={24} /> : null}<Txt size={13} color={p.mu} style={stacked ? undefined : { flexShrink: 1 }}>{title}</Txt></View>
      {stacked
        // No reserve: an absent status must not hold a line open, and the
        // title is no longer being centred between two ends.
        ? (end ?? null)
        : <View testID="task-header-end-reserve" style={{ minWidth: 64, alignItems: 'flex-end' }}>{end ?? null}</View>}
    </View>
  );
}