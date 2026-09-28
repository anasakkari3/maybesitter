/**
 * A row of category filters above a list (#415).
 *
 * ── Why it scrolls sideways instead of wrapping ──────────────────
 *
 * Six categories plus "All" is two lines of chips at Arabic text sizes on a
 * narrow phone, and two lines of filters above a list of four commitments is a
 * screen that is mostly chrome. Sideways is the shape people already know from
 * the filter rows in their chat apps, and it keeps the list where the eye
 * expects it however many categories the user keeps.
 *
 * The bar draws itself only when there is something to choose: the caller
 * passes chips built by `categoryChipsFor`, which is "All" alone when nothing
 * on the list is categorised. One chip is not a choice, so the bar renders
 * nothing rather than a single tappable "All" that does nothing.
 *
 * ── RTL: reversed here, because nothing else reverses it ─────────
 *
 * Direction in this app is style-only — the root View's `direction`, never
 * `I18nManager` — and a horizontal ScrollView lays its content out left to
 * right under it. So `DirectionalScrollRow` reverses the chips for Arabic and
 * Hebrew and opens the row at its end, putting "All" at the right edge where
 * reading starts (first iPhone run, L7).
 */
import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Pill } from '../../ui/primitives';
import { DirectionalScrollRow } from '../../ui/directionalScroll';
import type { CategoryChip } from './categoryFilter';

/** The copy key for each chip. Total, so a new category cannot render as a code. */
const LABEL: Record<CategoryChip, string> = {
  all: 'catAll',
  work: 'catWork',
  family: 'catFamily',
  health: 'catHealth',
  finance: 'catFinance',
  social: 'catSocial',
  errands: 'catErrands',
};

export function CategoryBar({
  chips,
  selected,
  onSelect,
}: {
  chips: readonly CategoryChip[];
  selected: CategoryChip;
  onSelect: (chip: CategoryChip) => void;
}) {
  const { t } = useApp();
  const strings = t as unknown as Record<string, string>;

  // One chip is "All" alone: a filter with nothing to filter to. Drawing it
  // would promise a choice the list cannot honour.
  if (chips.length < 2) return null;

  return (
    <View testID="category-bar">
      <DirectionalScrollRow
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
        // The row is a filter, not a page: keep the list reachable by a flick
        // that starts on a chip.
        keyboardShouldPersistTaps="handled"
      >
        {chips.map((chip) => (
          <Pill
            key={chip}
            testID={`category-chip-${chip}`}
            label={strings[LABEL[chip]]!}
            kind={chip === selected ? 'ink' : 'outline'}
            onPress={() => onSelect(chip)}
            size={13}
            weight={500}
            pad={14}
          />
        ))}
      </DirectionalScrollRow>
    </View>
  );
}
