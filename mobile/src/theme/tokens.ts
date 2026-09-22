// Design tokens, extracted from the Claude Design export (design/) and pinned
// to its manifest by src/design/tokens.source.json. See src/design/README.md.
//
// Two layers, one set of values:
//   - `color.light` / `color.dark` name the ROLE (background, textPrimary,
//     brand…). New code uses these.
//   - `palettes` keeps the short keys the nine shipped screens already use
//     (bg, sf, tx, ac…) as aliases of the same strings, so the verified design
//     implementation did not have to be rewritten to gain semantic names.
//
// Identity, unchanged from Round 1 to Round 2: neutral greys, one deep-teal
// accent for actions and "done", one warm sand for "must". Nothing is red
// anywhere — there is no danger role, because the product has no failure state
// to paint.
//
// Round 2 declares these as CSS custom properties rather than inline literals,
// and every colour below survived that round byte for byte. What it adds and
// this file does not carry yet: lnStrong, acd, ul, acOnInk, dis/disTx, prop,
// ink/onInk, the two shadow roles, a nine-step type ramp and a --ts text-size
// multiplier. Those land with the screens that use them — see
// docs/design/round-1-to-round-2.md.

export type Scheme = 'light' | 'dark';

export interface ColorRoles {
  background: string;
  surface: string;
  surfaceAlt: string;
  surfaceBar: string;
  /** `--sfBarSolid`: the bar where a blur is unavailable (Android, reduce-transparency). */
  surfaceBarSolid: string;
  textPrimary: string;
  textMuted: string;
  border: string;
  /** `--lnStrong`: an unchecked circle, a divider that has to carry weight. */
  borderStrong: string;
  brand: string;
  brandContainer: string;
  /** `--acd`: the pressed and hovered accent. */
  brandPressed: string;
  onBrand: string;
  /** `--acOnInk`: the accent where it sits on an inverted surface. */
  brandOnInk: string;
  /** `--ul`: underlines, which are not the border colour. */
  underline: string;
  must: string;
  mustContainer: string;
  /** `--dis` / `--disTx`: a button that cannot be pressed yet, and its label. */
  disabled: string;
  onDisabled: string;
  /** `--prop`: the dashed edge that marks a card as a proposal, not a saved thing. */
  proposal: string;
  /** `--ink` / `--onInk`: an inverted surface and what is legible on it. */
  ink: string;
  onInk: string;
  hatch: string;
  overlay: string;
}

export const color: Record<Scheme, ColorRoles> = {
  light: {
    background: '#F5F7F8',
    surface: '#FFFFFF',
    surfaceAlt: '#EDF0F2',
    surfaceBar: 'rgba(255,255,255,0.88)',
    surfaceBarSolid: '#FFFFFF',
    textPrimary: '#14181B',
    textMuted: '#5F6B70',
    border: 'rgba(20,24,27,0.08)',
    borderStrong: 'rgba(20,24,27,0.22)',
    brand: '#1F7A8C',
    brandContainer: '#DFEFF3',
    brandPressed: '#14586A',
    onBrand: '#FFFFFF',
    brandOnInk: '#9EDCE9',
    underline: 'rgba(31,122,140,0.40)',
    must: '#8A6A2E',
    mustContainer: '#F3ECDD',
    disabled: '#E4E8EA',
    onDisabled: '#4F5A5F',
    proposal: 'rgba(31,122,140,0.50)',
    ink: '#14181B',
    onInk: '#F5F7F8',
    hatch: 'rgba(20,24,27,0.10)',
    overlay: 'rgba(10,14,16,0.45)',
  },
  dark: {
    background: '#101416',
    surface: '#1A2023',
    surfaceAlt: '#242B2F',
    surfaceBar: 'rgba(26,32,35,0.90)',
    surfaceBarSolid: '#1A2023',
    textPrimary: '#ECEFF1',
    textMuted: '#9AA6AB',
    border: 'rgba(236,239,241,0.10)',
    borderStrong: 'rgba(236,239,241,0.28)',
    brand: '#6FC3D6',
    brandContainer: 'rgba(111,195,214,0.16)',
    brandPressed: '#8ED3E3',
    // Round 1 put white here. White on #6FC3D6 measures 2.01:1, far below the
    // 4.5:1 minimum; dark ink on the same accent measures 9.22:1, so the app
    // deviated. Round 2 specifies this value itself (`--onac:#101416`), so the
    // deviation is closed — see "deviationsResolved" in tokens.source.json.
    onBrand: '#101416',
    brandOnInk: '#6FC3D6',
    underline: 'rgba(142,211,227,0.45)',
    must: '#D9B06B',
    mustContainer: 'rgba(217,176,107,0.16)',
    disabled: '#2A3236',
    onDisabled: '#B4BEC3',
    proposal: 'rgba(111,195,214,0.55)',
    ink: '#ECEFF1',
    onInk: '#101416',
    hatch: 'rgba(255,255,255,0.08)',
    // Round 2 deepens the dark scrim and takes the blue out of it:
    // rgba(10,14,16,.45) became rgba(0,0,0,.55).
    overlay: 'rgba(0,0,0,0.55)',
  },
};

export type Palette = {
  bg: string; sf: string; sf2: string; sfBar: string;
  tx: string; mu: string; ln: string;
  ac: string; acs: string; wm: string; wms: string;
  hatch: string; scrim: string; onAccent: string;
  // Round 2. Same short names the export uses, so a screen that migrates
  // reads the same token name in both places.
  sfBarSolid: string; lnStrong: string; acd: string; acOnInk: string;
  ul: string; dis: string; disTx: string; prop: string;
  ink: string; onInk: string;
  shadow: boolean;
};

/** The short names the screens use. Every value is an alias of a role above. */
function paletteFor(scheme: Scheme, shadow: boolean): Palette {
  const c = color[scheme];
  return {
    bg: c.background, sf: c.surface, sf2: c.surfaceAlt, sfBar: c.surfaceBar,
    tx: c.textPrimary, mu: c.textMuted, ln: c.border,
    ac: c.brand, acs: c.brandContainer, wm: c.must, wms: c.mustContainer,
    hatch: c.hatch, scrim: c.overlay, onAccent: c.onBrand,
    sfBarSolid: c.surfaceBarSolid, lnStrong: c.borderStrong, acd: c.brandPressed,
    acOnInk: c.brandOnInk, ul: c.underline, dis: c.disabled, disTx: c.onDisabled,
    prop: c.proposal, ink: c.ink, onInk: c.onInk,
    shadow,
  };
}

export const palettes: Record<Scheme, Palette> = {
  light: paletteFor('light', true),
  dark: paletteFor('dark', false),
};

/** 2-pt grid as the export uses it. */
export const space = {
  xxs: 2, xs: 4, sm: 6, md: 8, lg: 10, xl: 12, xxl: 14,
  gutter: 16, section: 18, screen: 20, wide: 24, page: 28,
} as const;

export const radius = {
  chip: 999, circle: 50, card: 24, tile: 20, sheet: 36,
  sheetHandle: 18, pill: 16, row: 14, small: 12, tiny: 9, hairline: 2,
} as const;

/**
 * Round 1's font sizes, named by where they appear. The shipped screens are
 * written against these, so they stay until each screen migrates.
 */
export const typeScale = {
  display: 34, title1: 28, title2: 26, section: 22, cardTitle: 19,
  bodyLarge: 16, body: 15, bodySmall: 14, label: 13, caption: 12, micro: 11,
} as const;

/**
 * Round 2's ramp: eleven steps narrowed to nine. It drops 26 / 22 / 19 / 16
 * and adds 20 / 17. Every size is multiplied by the reader's text scale — see
 * src/theme/textScale.ts.
 */
export const typeScaleR2 = {
  display: 34, title: 28, h2: 20, card: 17, body: 15,
  body2: 14, label: 13, caption: 12, meta: 11,
} as const;

export const lineHeight = { arabic: 1.6, latin: 1.4, tight: 1.15, heading: 1.3 } as const;

/** Durations in ms, with the export's single easing curve. */
export const motion = {
  easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  screenIn: 340,
  sheetUp: 380,
  pop: 500,
  press: 160,
  pressScale: 0.95,
  shimmer: 1600,
  ring: 2400,
} as const;

export function cardShadow(p: Palette) {
  return p.shadow
    ? { shadowColor: '#14181B', shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 2 }
    : {};
}

/**
 * `--shBar`: the floating bar's shadow, which is heavier than a card's and is
 * the one shadow the dark scheme keeps.
 */
export function barShadow(p: Palette) {
  return {
    shadowColor: '#000000',
    shadowOpacity: p.shadow ? 0.12 : 0.4,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  };
}

export function accentGlow(p: Palette, strength = 0.28) {
  return { shadowColor: p.ac, shadowOpacity: strength, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 6 };
}
