// Stitch redesign, owner decision 2026-10-02 (docs/design/stitch-2026-10-02/).
// Navy dark is the hero; warm paper light remains selectable. One palette for
// every screen: the "reference" and capture-chat palettes below are aliases of
// this one, not separate looks. Provenance: src/design/stitch.source.json.
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
    background: '#F7F5F1',
    glass: '#FFFFFF',
    success: '#1E6B45',
    successContainer: '#E2F5EA',
    onSuccess: '#FFFFFF',
    surface: '#FFFFFF',
    surfaceAlt: '#F0EDE7',
    surfaceBar: 'rgba(255,255,255,0.96)',
    surfaceBarSolid: '#FFFFFF',
    textPrimary: '#1A1F2B',
    textMuted: '#5B6375',
    border: '#E6E1D8',
    borderStrong: 'rgba(26,31,43,0.30)',
    brand: '#C2394A',
    brandContainer: '#FBE3E6',
    // The coral chip text: solid on its own tint (Stitch light, `#A8323F`).
    brandPressed: '#A8323F',
    onBrand: '#FFFFFF',
    brandOnInk: '#FF8A8A',
    underline: 'rgba(194,57,74,0.45)',
    must: '#7A5200',
    mustContainer: '#FDF1DA',
    disabled: '#E6E1D8',
    onDisabled: '#4C5466',
    proposal: 'rgba(122,82,0,0.55)',
    ink: '#1A1F2B',
    onInk: '#F7F5F1',
    hatch: 'rgba(26,31,43,0.08)',
    overlay: 'rgba(14,21,38,0.45)',
  },
  dark: {
    background: '#0E1526',
    glass: '#172036',
    success: '#4CC38A',
    successContainer: 'rgba(76,195,138,0.15)',
    onSuccess: '#0E1526',
    surface: '#172036',
    surfaceAlt: '#1F2A44',
    surfaceBar: 'rgba(23,32,54,0.96)',
    surfaceBarSolid: '#172036',
    textPrimary: '#F3F5FA',
    textMuted: '#A9B2C7',
    border: 'rgba(169,178,199,0.16)',
    borderStrong: 'rgba(169,178,199,0.40)',
    brand: '#FF6B6B',
    brandContainer: 'rgba(255,107,107,0.15)',
    brandPressed: '#FF8A8A',
    // Navy on coral: white on #FF6B6B is 2.6:1, navy is above 6:1.
    onBrand: '#0E1526',
    brandOnInk: '#C2394A',
    underline: 'rgba(255,138,138,0.50)',
    must: '#F5B547',
    mustContainer: 'rgba(245,181,71,0.15)',
    disabled: '#1F2A44',
    onDisabled: '#A9B2C7',
    proposal: 'rgba(245,181,71,0.60)',
    ink: '#F3F5FA',
    onInk: '#0E1526',
    hatch: 'rgba(255,255,255,0.07)',
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

/**
 * The names Today, Calendar and the capture chat were written against when
 * they carried their own look (September 29). Since the Stitch redesign every
 * screen shares one palette, so these are the same values plus the three
 * extra roles those screens read: `focus` / `focusSoft` (a selected filter),
 * and `heroEdge` (the edge of the one card that is the next step).
 */
export const referencePalettes: Record<Scheme, Palette & {
  focus: string; focusSoft: string; heroEdge: string;
}> = {
  dark: { ...palettes.dark, focus: palettes.dark.tx, focusSoft: palettes.dark.sf2, heroEdge: 'rgba(255,107,107,0.45)' },
  light: { ...palettes.light, focus: palettes.light.tx, focusSoft: palettes.light.sf2, heroEdge: 'rgba(194,57,74,0.35)' },
};

/** Subtle navy (dark) and warm-paper (light) washes; no pink, no colour that competes with the accent. */
export const referenceGradients: Record<Scheme, Record<'hero' | 'plan' | 'waiting' | 'surface', readonly [string, string, string]>> = {
  dark: {
    hero: ['#1C2743', '#192339', '#172036'],
    plan: ['#1B2541', '#182238', '#172036'],
    waiting: ['#1B2541', '#182238', '#172036'],
    surface: ['#172036', '#172036', '#162035'],
  },
  light: {
    hero: ['#FFFFFF', '#FDFCFA', '#FAF8F4'],
    plan: ['#FFFFFF', '#FDFCFA', '#FAF8F4'],
    waiting: ['#FFFFFF', '#FDFCFA', '#FAF8F4'],
    surface: ['#FFFFFF', '#FFFFFF', '#FDFCFA'],
  },
};

/** 2-pt grid as the export uses it. */
export const space = {
  xxs: 2, xs: 4, sm: 6, md: 8, lg: 10, xl: 12, xxl: 14,
  gutter: 16, section: 18, screen: 20, wide: 24, page: 28,
} as const;

export const radius = {
  chip: 999, circle: 50, card: 20, tile: 20, sheet: 36,
  sheetHandle: 18, pill: 16, row: 14, small: 12, tiny: 9, hairline: 2,
} as const;

/**
 * Round 1's font sizes, named by where they appear. The shipped screens are
 * written against these, so they stay until each screen migrates.
 */
export const typeScale = {
  display: 34, title1: 28, title2: 26, section: 22, cardTitle: 19,
  bodyLarge: 16, body: 15, bodySmall: 14, label: 13, caption: 12, micro: 12,
} as const;

/**
 * Round 2's ramp: eleven steps narrowed to nine. It drops 26 / 22 / 19 / 16
 * and adds 20 / 17. Every size is multiplied by the reader's text scale — see
 * src/theme/textScale.ts. Nothing is below 12 (Stitch, 2026-10-02): `meta`
 * and `micro` were 11 and are 12 now; tab labels and chips use 13.
 */
export const typeScaleR2 = {
  display: 34, title: 28, h2: 20, card: 17, body: 15,
  body2: 14, label: 13, caption: 12, meta: 12,
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

export const lineHeight = { arabic: 1.7, latin: 1.4, tight: 1.15, heading: 1.3 } as const;

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

/**
 * The capture chat's palette. It had its own darker coral look (September 29);
 * since the Stitch redesign it is the app palette, plus the one extra role the
 * chat reads (`iconBg`, the tint behind a review row's icon).
 */
export function captureChatPalette(_scheme: Scheme, base: Palette): Palette & { iconBg: string } {
  return { ...base, iconBg: base.acs };
}
