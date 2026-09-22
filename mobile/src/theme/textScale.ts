import { useWindowDimensions } from 'react-native';

/**
 * Text size and layout mode — two different things.
 *
 * Round 1 had no answer here at all: `Txt` set a fixed `fontSize`, left
 * React Native's `allowFontScaling` at its default of true, and computed a
 * fixed `lineHeight` from the unscaled size. So the OS enlarged every glyph
 * without any layout accommodating it, every string was drawn into a line box
 * sized for 1×, and the floating tab bar's labels grew until the pill broke.
 *
 * Round 2 names three steps — default 1 · large 1.2 · xl 1.45 — and
 * multiplies its whole ramp by one of them, because a prototype's text size is
 * a picker. A phone's is not. So the app separates:
 *
 *   TEXT SCALE   the reader's actual font scale, continuous, never capped.
 *                Someone at 2.0× reads at 2.0×. `Txt` uses this only to size
 *                its line box, because React Native scales `fontSize` itself
 *                and leaves `lineHeight` alone.
 *
 *   LAYOUT MODE  which of the design's three structures the chrome renders
 *                in. It saturates at `xl`: past that, the text keeps growing
 *                and the structure holds.
 *
 * ── Where the mode boundaries come from ──────────────────────────
 *
 * Not from the midpoints of the design's numbers. They follow the platform's
 * own content-size categories, because those are the steps a reader actually
 * moves through in Settings and the sizes we can verify against:
 *
 *   iOS  Large 1.00 · xLarge 1.12 · xxLarge 1.24 · xxxLarge 1.35
 *        AX1 1.64 · AX2 1.94 · AX3 2.35 · AX4 2.76 · AX5 3.12
 *
 * `large` begins at xxLarge (1.24): the first size at which 15-pt body copy
 * crosses 18 pt and two-column rows start to want one column. `xl` begins at
 * the first accessibility size, AX1 (1.64): the point at which iOS itself
 * switches its tab bars and navigation bars to their large-content forms.
 *
 * Whether a *particular* label still fits is a different question, answered
 * by measuring — see `TabBar`. The mode is the structural default; the
 * measurement is the truth.
 */
export type LayoutMode = 'normal' | 'large' | 'xl';

/** Platform content-size boundaries the layout modes follow. */
export const LAYOUT_MODE_FROM = { large: 1.24, xl: 1.64 } as const;

/** A missing or nonsense reading is an ordinary phone, not a broken one. */
export function textScaleOf(fontScale: number | undefined): number {
  if (fontScale === undefined || !Number.isFinite(fontScale) || fontScale <= 0) return 1;
  return fontScale;
}

export function layoutModeFor(fontScale: number | undefined): LayoutMode {
  const scale = textScaleOf(fontScale);
  if (scale >= LAYOUT_MODE_FROM.xl) return 'xl';
  if (scale >= LAYOUT_MODE_FROM.large) return 'large';
  return 'normal';
}

/** The reader's font scale, live, uncapped. */
export function useTextScale(): number {
  return textScaleOf(useWindowDimensions().fontScale);
}

/** The structure the chrome should render in, live. */
export function useLayoutMode(): LayoutMode {
  return layoutModeFor(useWindowDimensions().fontScale);
}
