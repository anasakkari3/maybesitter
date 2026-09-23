// Coral continuation, explicitly requested 2026-09-23 from the 15 supplied
// reference screens. Layout/type/motion retain the verified R2 foundation.
// See src/design/coral.source.json for the approved palette and provenance.
// Coral means action; green means confirmed; amber means attention/proposal.

export type Scheme = 'light' | 'dark';

export interface ColorRoles {
  background: string;
  glass: string;
  success: string;
  successContainer: string;
  onSuccess: string;
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
    background: '#F8F6F6',
    glass: '#FFFFFF',
    success: '#176B4D',
    successContainer: '#E1F3E9',
    onSuccess: '#FFFFFF',
    surface: '#FFFFFF',
    surfaceAlt: '#F0EAEC',
    surfaceBar: 'rgba(255,255,255,0.88)',
    surfaceBarSolid: '#FFFFFF',
    textPrimary: '#202122',
    textMuted: '#626268',
    border: 'rgba(20,24,27,0.08)',
    borderStrong: 'rgba(20,24,27,0.22)',
    brand: '#B82F49',
    brandContainer: '#FCE4E9',
    brandPressed: '#9F233E',
    onBrand: '#FFFFFF',
    brandOnInk: '#FF8093',
    underline: 'rgba(184,47,73,0.45)',
    must: '#8A6A2E',
    mustContainer: '#F3ECDD',
    disabled: '#E4E8EA',
    onDisabled: '#4F5A5F',
    proposal: 'rgba(138,106,46,0.60)',
    ink: '#14181B',
    onInk: '#F5F7F8',
    hatch: 'rgba(20,24,27,0.10)',
    overlay: 'rgba(10,14,16,0.45)',
  },
  dark: {
    background: '#1C1D1E',
    glass: 'rgba(255,255,255,0.055)',
    success: '#70DEB0',
    successContainer: '#253D34',
    onSuccess: '#17251F',
    surface: '#292A2C',
    surfaceAlt: '#343538',
    surfaceBar: 'rgba(30,31,33,0.90)',
    surfaceBarSolid: '#252628',
    textPrimary: '#F7F5F5',
    textMuted: '#B5B3BA',
    border: 'rgba(236,239,241,0.10)',
    borderStrong: 'rgba(236,239,241,0.28)',
    brand: '#FF667D',
    brandContainer: '#442D34',
    brandPressed: '#FF8FA0',
    // Ink on bright coral keeps normal-size button labels above 4.5:1.
    onBrand: '#23181C',
    brandOnInk: '#B82F49',
    underline: 'rgba(255,143,160,0.50)',
    must: '#D9B06B',
    mustContainer: 'rgba(217,176,107,0.16)',
    disabled: '#36373A',
    onDisabled: '#BEBCC3',
    proposal: 'rgba(217,176,107,0.65)',
    ink: '#F7F5F5',
    onInk: '#1C1D1E',
    hatch: 'rgba(255,255,255,0.08)',
    // Round 2 deepens the dark scrim and takes the blue out of it:
    // rgba(10,14,16,.45) became rgba(0,0,0,.55).
    overlay: 'rgba(0,0,0,0.55)',
  },
};

export type Palette = {
  bg: string; sf: string; sf2: string; sfBar: string;
  glass: string; success: string; successSoft: string; onSuccess: string;
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
    glass: c.glass, success: c.success, successSoft: c.successContainer, onSuccess: c.onSuccess,
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

/** Product roles use the Round-2 ramp; screens choose meaning, not a new size. */
export const typography = {
  page: { size: typeScaleR2.title, weight: 600 },
  section: { size: typeScaleR2.h2, weight: 600 },
  card: { size: typeScaleR2.card, weight: 600 },
  body: { size: typeScaleR2.body, weight: 400 },
  supporting: { size: typeScaleR2.body2, weight: 400 },
  label: { size: typeScaleR2.label, weight: 600 },
  metadata: { size: typeScaleR2.caption, weight: 400 },
  action: { size: typeScaleR2.body, weight: 600 },
} as const;
export type TextRole = keyof typeof typography;

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
