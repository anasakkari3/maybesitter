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
 * `flex: 1` for a node whose style — or whose parent's direction — changes
 * with the layout mode.
 *
 * Never `flex: N` (or any `flexBasis`) there. Yoga keeps the flex basis it
 * computed for a node (`layout.computedFlexBasis`), and recomputes a basis
 * that comes from `flex`/`flexBasis` only while that cache is empty
 * (`computeFlexBasisForChild`, CalculateLayout.cpp). Plain Yoga empties it
 * whenever a style changes (`Node::markDirtyAndPropagate`); Fabric does not —
 * a clone copies the Yoga node with its layout, and new props only
 * `setDirty(true)` it (`YogaLayoutableShadowNode::updateYogaProps`, RN 0.86).
 * So a node that comes back to `flex: 1` from a mode where its basis came from
 * a width or from measuring keeps that old basis: after a live change from AX5
 * back to the default size each tab item kept its AX5 third of the bar (about
 * 125 pt) and «احكيها» and «يتابع لك» went off the screen, while a fresh open
 * at the default size was fine (simulator 2026-10-23).
 *
 * Two other branches of the same function set the basis on every layout,
 * whatever the cache holds: a definite `width` (in a row; `height` in a
 * column), and measuring the content when there is no basis and no size.
 *
 *   fillRow          exactly what `flex: 1` resolves to in RN's Yoga, in a row
 *                    whose width is known: grow 1, shrink 0 (Fabric does not
 *                    use web defaults, `Node::resolveFlexShrink`) and a zero
 *                    basis — from `width: 0`, which `maxOrDefined(width,
 *                    padding + border)` turns into the same number `flexBasis:
 *                    0` gives. Equal shares when every item has it; the room
 *                    the siblings leave when one has it. Only in a row: in a
 *                    column the `width` would be the cross size, so a stacked
 *                    style must not carry it.
 *   growFromContent  grow 1, shrink 0, basis measured from the content on
 *                    every layout. Where `flex: 1` resolves from content
 *                    anyway: an item of a horizontal scroll (the row's width
 *                    is unknown while Yoga measures it, so `flex: 1` measures
 *                    — and keeps that measurement as its basis), or a child
 *                    whose main axis is a column of unknown height. Each use
 *                    says why it is not `fillRow`.
 *
 * Plain `flex: 1` stays fine where neither it nor its parent's direction ever
 * changes.
 */
export const fillRow = { flexGrow: 1, flexShrink: 0, width: 0 } as const;
export const growFromContent = { flexGrow: 1, flexShrink: 0 } as const;
