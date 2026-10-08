import React from 'react';
import { View } from 'react-native';
import type { CaptureEntry } from '../../api/schemas/capture';
import { useApp } from '../../state/AppContext';
import { Disclosure } from '../../ui/Disclosure';
import { Pill } from '../../ui/primitives';

const ENTRY_COPY = {
  goal: { label: 'xEntryGoal', why: 'xEntryGoalWhy' },
  habit: { label: 'xEntryHabit', why: 'xEntryHabitWhy' },
  thought: { label: 'xEntryThought', why: 'xEntryThoughtWhy' },
} as const;

/**
 * «ضيف هدف» / «ضيف عادة» / «احكي فكرة» (M3b, D1): one button that opens the
 * one chat knowing which page it came from, with its reason behind the arrow
 * (owner rule 2026-10-06). Each names its result, which is what separates the
 * goals page's entry from «يتابع لك»'s panel (condition 10). The arrow's
 * screen-reader label names its entry («ليش؟ ضيف هدف»), since several may share a screen.
 */
export function ChatEntryButton({ entry, testID }: { entry: CaptureEntry; testID: string }) {
  const { t, actions } = useApp();
  const copy = ENTRY_COPY[entry];
  const label = t[copy.label];
  return (
    <View style={{ gap: 4 }}>
      <Disclosure id={testID} body={t[copy.why]} label={label}>
        <Pill testID={testID} label={label} onPress={() => actions.goCapture('tab', 'text', entry)} style={{ alignSelf: 'flex-start' }} />
      </Disclosure>
    </View>
  );
}

/** A quiet block the height of the entry, while the capability probe is out (R004). */
export function ChatEntryPlaceholder({ testID }: { testID: string }) {
  return <View testID={testID} style={{ minHeight: 48 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />;
}
