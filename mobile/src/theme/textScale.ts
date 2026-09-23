import { useWindowDimensions } from 'react-native';

/**
 * Text size and layout mode — two different things.
 *
 * Native text and adaptive layout have separate ownership:
 *
 *   TEXT SCALE   React Native applies the reader's actual scale to fontSize
 *                AND lineHeight. Txt supplies base metrics; neither is capped.
 *                useTextScale is for geometric controls that need to grow,
 *                such as calendar day targets, never a second font multiplier.
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
