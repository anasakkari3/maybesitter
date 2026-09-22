import { useWindowDimensions } from 'react-native';

/**
 * The reader's text size, as Round 2 models it.
 *
 * Round 1 had no answer here at all: `Txt` set a fixed `fontSize` and left
 * React Native's `allowFontScaling` at its default of true, so the OS scaled
 * every label without a ceiling and without any layout accommodating it. At
 * the accessibility sizes the floating tab bar's labels grew past the pill
 * that holds them — the bar has a fixed 56-pt capture button and 8-pt padding
 * — and the row broke. Nothing in the app read the font scale, so nothing
 * could react to it.
 *
 * Round 2 names three steps and multiplies its whole type ramp by them:
 *
 *   default 1 · large 1.2 · xl 1.45
 *
 * and at `xl` the tab bar shows icons only.
 *
 * ── How this differs from the export, on purpose ─────────────────
 *
 * The export is a prototype: `textSize` is a picker with three options, so its
 * scale is exactly one of three numbers. Snapping a real reader to the nearest
 * step would *shrink* text for anyone whose chosen size falls between two of
 * them — someone at 1.35× would be served 1.2×. So the app keeps the platform's
 * own continuous scaling and takes two things from Round 2 instead:
 *
 *   - `MAX_TEXT_SCALE`, the ceiling. Text scales with the OS up to 1.45× and
 *     stops, which is what keeps the geometry inside the design's bounds.
 *   - `textStepFor`, the discrete step, for layout decisions like the tab
 *     bar's. Thresholds sit at the midpoints between the ramp's values.
 *
 * So a reader at 1.35× gets text at 1.35× and the `xl` layout.
 */
export const TEXT_SCALE = { default: 1, large: 1.2, xl: 1.45 } as const;

export type TextStep = keyof typeof TEXT_SCALE;

/** The ceiling. Text never scales past the largest step the design lays out. */
export const MAX_TEXT_SCALE = TEXT_SCALE.xl;

/** Midpoints between the ramp's three values. */
const LARGE_FROM = (TEXT_SCALE.default + TEXT_SCALE.large) / 2; // 1.1
const XL_FROM = (TEXT_SCALE.large + TEXT_SCALE.xl) / 2; // 1.325

/**
 * Which of the design's three layouts a font scale belongs to.
 *
 * A non-finite or absent scale — some hosts do not report one — reads as
 * `default` rather than throwing the layout into its most degraded form.
 */
export function textStepFor(fontScale: number | undefined): TextStep {
  if (!fontScale || !Number.isFinite(fontScale)) return 'default';
  if (fontScale >= XL_FROM) return 'xl';
  if (fontScale >= LARGE_FROM) return 'large';
  return 'default';
}

/** What a `fontSize` actually renders at: the OS scale, held at the ceiling. */
export function effectiveTextScale(fontScale: number | undefined): number {
  if (!fontScale || !Number.isFinite(fontScale) || fontScale < 1) return 1;
  return Math.min(fontScale, MAX_TEXT_SCALE);
}

/** The reader's step, live — it changes without the app restarting. */
export function useTextStep(): TextStep {
  return textStepFor(useWindowDimensions().fontScale);
}

/** The reader's effective scale, live. */
export function useTextScale(): number {
  return effectiveTextScale(useWindowDimensions().fontScale);
}
