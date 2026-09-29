import { useCallback, useRef, useState, type RefObject } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';
import type { LayoutMode } from '../../theme/textScale';

/**
 * The composer field fits the room the keyboard leaves (UAT round 6, #5).
 *
 * The field is a multiline TextInput that scrolls itself, so iOS keeps the
 * caret inside the field's own frame. That is only worth anything if the
 * field's frame is on screen. It had a fixed cap (220pt, 260 at large text)
 * — taller than all the room left between the header and the footer once the
 * keyboard was up (~207pt on the UAT iPhone, the field starting 58pt into
 * it). So the field grew to 313–531pt while the footer began at 462, the
 * caret typed on under «فهمها», and the ScrollView never moved.
 *
 * Two parts, both measured from layout events rather than keyboard events —
 * `AvoidKeyboard` already shrinks the ScrollView by exactly the keyboard's
 * overlap, so its viewport height is the room there is:
 *
 * 1. The field's cap is the smaller of its resting cap and the space from its
 *    top to the viewport's bottom. A field that fits scrolls itself and
 *    nothing else has to move.
 * 2. When even that is too small (large Dynamic Type, landscape) the field
 *    keeps a floor, and the ScrollView scrolls — the least distance — until
 *    the whole field shows. When the field is taller than the viewport, its
 *    bottom wins: that is where the caret types.
 *
 * No animation: the lift is instant (UAT round 5, N17), and so is this.
 */

/**
 * Where the composer's parts sit at each layout mode (UAT round 6, D-g).
 *
 * The fit below can only share out the room the ScrollView gets. At the
 * accessibility text sizes the header (~248pt: the pill, the name and the AI
 * chip, stacked) and the stacked footer (~246pt: mic and language chip on one
 * line, «فهمها» under them) were fixed blocks, and with the keyboard up and
 * the verify-email banner above they took all 405pt there was: the ScrollView
 * was 69pt at AX1, 38 at AX2 and 0 from AX3 on, and «فهمها» went behind the
 * keyboard at AX4 and AX5.
 *
 * So from the first accessibility size — the boundary where the task header
 * stacks — nothing but the controls that act on the text is fixed:
 *
 * - the header is scroll content, so the ScrollView owns everything between
 *   the banner and the footer, and `revealOffset` scrolls the header away to
 *   show the field (scrolling back up brings Cancel back);
 * - the footer is one row, the mic and «فهمها» — the default size's row — and
 *   the language chip, which only says which language the mic listens for,
 *   moves into the scroll content beside Paste.
 *
 * At AX5 that footer is ~133pt, leaving the ScrollView ~272 of the 405: room
 * for the field's two-line floor (~252) and its margin.
 *
 * Below the accessibility sizes nothing changes: `normal` is the row the
 * design draws, and `large` keeps the stacked footer that fits there.
 */
export function composerLayout(mode: LayoutMode): {
  headerScrolls: boolean;
  footer: 'row' | 'stacked';
  languageInFooter: boolean;
} {
  if (mode === 'xl') return { headerScrolls: true, footer: 'row', languageInFooter: false };
  return { headerScrolls: false, footer: mode === 'large' ? 'stacked' : 'row', languageInFooter: true };
}

/** The field's resting minimum, with the keyboard down. */
export const FIELD_MIN_HEIGHT = 140;
/** Below this the label scrolls away instead: two lines of Arabic at the base size. */
export const FIELD_FLOOR = 120;
/** The field's padding plus one line at the base size: the least that can hold a caret. */
export const FIELD_ONE_LINE = 88;
/** The field's vertical padding (18 top, 34 bottom for the counter). */
export const FIELD_PADDING = 52;
/** Between the field's bottom edge and the footer's hairline. */
export const FIELD_MARGIN = 8;

export function fieldHeights({ viewport, fieldTop, cap, line = 0 }: {
  /** The ScrollView's height, 0 before it has been laid out. */
  viewport: number;
  /** The field's top in scroll-content coordinates. */
  fieldTop: number;
  /** The resting cap (220, or 260 in the stacked layout). */
  cap: number;
  /**
   * One line of the field at the reader's text size, in points. At large
   * Dynamic Type a line is ~96pt, so the floors grow with it: two lines
   * before the label gives way, one line whatever happens.
   */
  line?: number;
}): { maxHeight: number; minHeight: number } {
  if (viewport <= 0) return { maxHeight: cap, minHeight: Math.min(FIELD_MIN_HEIGHT, cap) };
  const floor = Math.max(FIELD_FLOOR, FIELD_PADDING + 2 * line);
  const oneLine = Math.max(FIELD_ONE_LINE, FIELD_PADDING + line);
  const room = viewport - FIELD_MARGIN;
  const underLabel = room - fieldTop;
  const maxHeight = Math.round(Math.max(oneLine, Math.min(Math.max(cap, oneLine), room, Math.max(floor, underLabel))));
  return { maxHeight, minHeight: Math.min(FIELD_MIN_HEIGHT, maxHeight) };
}

/**
 * Where to scroll so the whole field shows, or null to stay put.
 *
 * Moves the least distance from `scrollY`; a field taller than the viewport
 * shows its bottom.
 */
export function revealOffset({ scrollY, fieldTop, fieldHeight, viewport }: {
  scrollY: number;
  fieldTop: number;
  fieldHeight: number;
  viewport: number;
}): number | null {
  if (viewport <= 0 || fieldHeight <= 0) return null;
  const showsBottom = fieldTop + fieldHeight + FIELD_MARGIN - viewport;
  const showsTop = fieldTop;
  const target = Math.max(0, Math.round(Math.max(showsBottom, Math.min(scrollY, showsTop))));
  return Math.abs(target - scrollY) < 1 ? null : target;
}

/**
 * Wires the two into the composer: layout handlers for the ScrollView, the
 * editor column and the field's wrapper, and the field's heights.
 *
 * `active` is false while the ScrollView shows something other than the
 * field (the discard question, the paste sheet, analyzing, a failure), so a
 * stale field measurement never scrolls those.
 */
export function useComposerFit(
  scrollRef: RefObject<ScrollView | null>,
  { cap, active, line }: { cap: number; active: boolean; line: number },
) {
  const [geometry, setGeometry] = useState({ viewport: 0, editorY: 0, fieldY: 0 });
  const live = useRef({ viewport: 0, editorY: 0, fieldY: 0, fieldHeight: 0, scrollY: 0 });

  const reveal = useCallback(() => {
    const g = live.current;
    if (!active) return;
    const y = revealOffset({ scrollY: g.scrollY, fieldTop: g.editorY + g.fieldY, fieldHeight: g.fieldHeight, viewport: g.viewport });
    if (y === null) return;
    g.scrollY = y;
    scrollRef.current?.scrollTo({ y, animated: false });
  }, [active, scrollRef]);

  const settle = useCallback(() => {
    const { viewport, editorY, fieldY } = live.current;
    setGeometry((prev) => (prev.viewport === viewport && prev.editorY === editorY && prev.fieldY === fieldY
      ? prev
      : { viewport, editorY, fieldY }));
    reveal();
  }, [reveal]);

  const onScrollLayout = useCallback((event: LayoutChangeEvent) => {
    live.current.viewport = event.nativeEvent.layout.height;
    settle();
  }, [settle]);

  const onEditorLayout = useCallback((event: LayoutChangeEvent) => {
    live.current.editorY = event.nativeEvent.layout.y;
    settle();
  }, [settle]);

  const onFieldLayout = useCallback((event: LayoutChangeEvent) => {
    live.current.fieldY = event.nativeEvent.layout.y;
    live.current.fieldHeight = event.nativeEvent.layout.height;
    settle();
  }, [settle]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    live.current.scrollY = event.nativeEvent.contentOffset.y;
  }, []);

  const heights = fieldHeights({ viewport: geometry.viewport, fieldTop: geometry.editorY + geometry.fieldY, cap, line });
  return { heights, onScrollLayout, onEditorLayout, onFieldLayout, onScroll };
}
