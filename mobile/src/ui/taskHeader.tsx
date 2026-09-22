import React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { Btn, Txt } from './primitives';

/**
 * The header of a task — a flow that owns the whole screen (capture, review,
 * share). Round 2's shape: a pill at the start that leaves or goes back, the
 * flow's name in the middle in the muted colour, and an optional end slot for
 * one small status such as «الذكاء: مطفي». The end slot keeps its width when
 * empty so the title stays centred.
 */
export function TaskHeader({ pill, onPill, title, end, pillTestID }: {
  pill: string;
  onPill: () => void;
  title: string;
  end?: React.ReactNode;
  pillTestID?: string | undefined;
}) {
  const { p } = useApp();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
      <Btn label={pill} onPress={onPill} testID={pillTestID} style={{ minHeight: 40, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 16, justifyContent: 'center' }}>
        <Txt size={13} weight={600}>{pill}</Txt>
      </Btn>
      <Txt size={13} color={p.mu} style={{ flexShrink: 1 }}>{title}</Txt>
      <View style={{ minWidth: 64, alignItems: 'flex-end' }}>{end ?? null}</View>
    </View>
  );
}
