import React, { useRef } from 'react';
import { ScrollView, View, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native';
import { useApp } from '../state/AppContext';

/**
 * A sideways row that reads from the right in Arabic and Hebrew.
 *
 * Direction in this app is style-only (`src/i18n/README.md`): the root View
 * sets `direction: 'rtl'` and `I18nManager` is never flipped. A horizontal
 * ScrollView does not follow that — its content is laid out left to right —
 * so an RTL row would put its first item on the left and open showing it
 * there. Under RTL this:
 *
 *  - reverses the children, so the first item is the last one laid out;
 *  - lays the content box out left to right *explicitly* (`direction: 'ltr'`)
 *    so there is exactly one flip — this reversal — whatever the platform's
 *    ScrollView does with an inherited direction;
 *  - packs the content to the end (`flexGrow: 1`, `justifyContent:
 *    'flex-end'`), so a row that fits on screen sits at the right edge
 *    instead of the left (review I2): scrolling cannot move a row that
 *    does not scroll;
 *  - opens a row wider than the screen scrolled to its end, where the first
 *    item now is;
 *  - gives each item its right-to-left direction back, so what is inside a
 *    chip lays out as it does everywhere else.
 *
 * The premise — that Fabric's horizontal ScrollView ignores the style-only
 * root direction — is what jest cannot see; it is a device check.
 *
 * `SetupLifeStep`'s prompts, the category chips and the week strip all use
 * it. A child's own handlers are untouched, so a tap still means the item it
 * names.
 */
export function DirectionalScrollRow({
  children,
  onContentSizeChange,
  contentContainerStyle,
  itemStyle,
  ...rest
}: Omit<ScrollViewProps, 'horizontal' | 'children'> & {
  children: React.ReactNode;
  /**
   * For items that size themselves against the row (`flex: 1` day cells):
   * under RTL each item sits in a wrapper, and the wrapper has to take the
   * share of the row the item used to.
   */
  itemStyle?: StyleProp<ViewStyle>;
}) {
  const { rtl } = useApp();
  const row = useRef<ScrollView>(null);
  const items = React.Children.toArray(children);
  return (
    <ScrollView
      ref={row}
      horizontal
      {...rest}
      contentContainerStyle={rtl
        ? [contentContainerStyle, { direction: 'ltr', flexGrow: 1, justifyContent: 'flex-end' }]
        : contentContainerStyle}
      onContentSizeChange={(width, height) => {
        if (rtl) row.current?.scrollToEnd({ animated: false });
        onContentSizeChange?.(width, height);
      }}
    >
      {rtl
        ? items.reverse().map((item, index) => (
          <View key={React.isValidElement(item) && item.key !== null ? item.key : index} style={[itemStyle, { direction: 'rtl' }]}>
            {item}
          </View>
        ))
        : items}
    </ScrollView>
  );
}
