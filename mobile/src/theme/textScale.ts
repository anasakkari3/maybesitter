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

/**
 * Row sizing for a node whose style changes with the layout mode — `{ flex: 1 }`
 * beside its controls at the ordinary sizes, something else when stacked.
 *
 * Never `flex: 1` (or any `flexBasis`) there. Yoga keeps the flex basis it
 * computed for a node (`layout.computedFlexBasis`) and recomputes a basis
 * that comes from `flex`/`flexBasis` only while that cache is empty
 * (`computeFlexBasisForChild`). Plain Yoga empties it whenever a style
 * changes (`markDirtyAndPropagate`); Fabric does not — a clone copies the
 * Yoga node with its layout, and new props only `setDirty(true)` it
 * (`YogaLayoutableShadowNode::updateYogaProps`, RN 0.86). So a node that
 * comes back to `flex: 1` from a mode where its basis came from a width or
 * from measuring keeps that old basis: after a live change from AX5 back to
 * the default size, each tab item kept its AX5 third of the bar (about
 * 125 pt) and «احكيها» and «يتابع لك» went off the screen, while a fresh open
 * at the default size was fine (simulator 2026-10-23).
 *
 * A basis taken from `width`, or from measuring the content, is recomputed on
 * every layout, so these two say the same as `flex: 1` without the cache:
 *
 *   growInRow   one node takes the room its siblings leave (basis: its
 *               content; it grows into the rest, or gives way if the row is
 *               short). `flex: 1` beside a control.
 *   shareOfRow  equal shares of a row (basis 0, from `width`). `flex: 1` on
 *               every item. Only in a row: the `width` would be the cross
 *               size in a column, so a stacked layout must not carry it.
 *
 * Plain `flex: 1` stays fine where it never changes and its parent's
 * direction never changes.
 */
export const growInRow = { flexGrow: 1, flexShrink: 1 } as const;
export const shareOfRow = { flexGrow: 1, flexShrink: 1, width: 0 } as const;
