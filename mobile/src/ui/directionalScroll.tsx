import React, { useRef } from 'react';
import { ScrollView, type ScrollViewProps } from 'react-native';
import { useApp } from '../state/AppContext';

/**
 * A sideways row that reads from the right in Arabic and Hebrew.
 *
 * Direction in this app is style-only (`src/i18n/README.md`): the root View
 * sets `direction: 'rtl'` and `I18nManager` is never flipped. A horizontal
 * ScrollView does not follow that — its content is laid out left to right —
 * so an RTL row would put its first item on the left and open showing it
 * there. This reverses the children for RTL and opens the row scrolled to its
 * end, which puts the first item at the right edge, where reading starts.
 *
 * `SetupLifeStep`'s prompts, the category chips and the week strip all use
 * it; one place to get this right rather than three to get it wrong. A child's
 * own handlers are untouched, so a tap still means the item it names.
 */
export function DirectionalScrollRow({
  children,
  onContentSizeChange,
  ...rest
}: Omit<ScrollViewProps, 'horizontal' | 'children'> & { children: React.ReactNode }) {
  const { rtl } = useApp();
  const row = useRef<ScrollView>(null);
  const items = React.Children.toArray(children);
  return (
    <ScrollView
      ref={row}
      horizontal
      {...rest}
      onContentSizeChange={(width, height) => {
        if (rtl) row.current?.scrollToEnd({ animated: false });
        onContentSizeChange?.(width, height);
      }}
    >
      {rtl ? items.reverse() : items}
    </ScrollView>
  );
}
