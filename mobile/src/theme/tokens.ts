// Round-1 identity (Claude Design · MaybeSitter.dc.html): neutral greys, one
// deep-teal accent for actions and "done", one warm sand for "must".
// Nothing is red anywhere.

export type Scheme = 'light' | 'dark';

export type Palette = {
  bg: string; sf: string; sf2: string; sfBar: string;
  tx: string; mu: string; ln: string;
  ac: string; acs: string; wm: string; wms: string;
  hatch: string; scrim: string; onAccent: string;
  shadow: boolean;
};

export const palettes: Record<Scheme, Palette> = {
  light: {
    bg: '#F5F7F8', sf: '#FFFFFF', sf2: '#EDF0F2', sfBar: 'rgba(255,255,255,0.86)',
    tx: '#14181B', mu: '#5F6B70', ln: 'rgba(20,24,27,0.08)',
    ac: '#1F7A8C', acs: '#DFEFF3', wm: '#8A6A2E', wms: '#F3ECDD',
    hatch: 'rgba(20,24,27,0.10)', scrim: 'rgba(10,14,16,0.45)', onAccent: '#FFFFFF',
    shadow: true,
  },
  dark: {
    bg: '#101416', sf: '#1A2023', sf2: '#242B2F', sfBar: 'rgba(26,32,35,0.88)',
    tx: '#ECEFF1', mu: '#9AA6AB', ln: 'rgba(236,239,241,0.10)',
    ac: '#6FC3D6', acs: 'rgba(111,195,214,0.16)', wm: '#D9B06B', wms: 'rgba(217,176,107,0.16)',
    hatch: 'rgba(255,255,255,0.08)', scrim: 'rgba(10,14,16,0.45)', onAccent: '#FFFFFF',
    shadow: false,
  },
};

export const radius = { chip: 999, card: 24, tile: 20, sheet: 36, row: 14 } as const;

export function cardShadow(p: Palette) {
  return p.shadow
    ? { shadowColor: '#14181B', shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 2 }
    : {};
}

export function accentGlow(p: Palette, strength = 0.28) {
  return { shadowColor: p.ac, shadowOpacity: strength, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 6 };
}
