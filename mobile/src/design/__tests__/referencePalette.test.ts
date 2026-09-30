import { describe, expect, it } from '@jest/globals';
import { referenceGradients, referencePalettes, type Scheme } from '../../theme/tokens';

function channels(hex: string): number[] {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
}
function luminance(rgb: readonly number[]): number {
  const linear = rgb.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
}
function contrast(foreground: string, background: string | readonly number[]): number {
  const a = luminance(channels(foreground));
  const b = luminance(typeof background === 'string' ? channels(background) : background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

describe('reference palette remains readable on the surfaces actually painted', () => {
  for (const scheme of ['light', 'dark'] as Scheme[]) {
    const palette = referencePalettes[scheme];
    for (const [tone, stops] of Object.entries(referenceGradients[scheme])) {
      it(`${scheme} ${tone}: its text roles meet 4.5:1 throughout the gradient`, () => {
        // The hero also paints a stale-proposal warning; saved-plan previews
        // paint completion labels directly on their gradient.
        const roles = ['tx', 'mu', ...(tone === 'hero' ? ['wm'] : []), ...(tone === 'plan' ? ['success'] : [])] as const;
        // Check the stops and intervening shades, not just the underlying card.
        for (let segment = 0; segment < stops.length - 1; segment += 1) {
          const start = channels(stops[segment]!);
          const end = channels(stops[segment + 1]!);
          for (let point = 0; point <= 20; point += 1) {
            const background = start.map((channel, index) => channel + (end[index]! - channel) * point / 20);
            for (const role of roles) {
              expect(contrast(palette[role as 'tx' | 'mu' | 'wm' | 'success'], background)).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      });
    }
    it(`${scheme}: action, selected-day, filter and focus labels meet 4.5:1`, () => {
      const pairs = [
        [palette.onAccent, palette.ac],
        [palette.onInk, palette.ink],
        [palette.tx, palette.sf],
        [palette.mu, palette.sf],
        [palette.tx, palette.sf2],
        [palette.mu, palette.bg],
        [palette.ac, palette.sfBarSolid],
        [palette.focus, palette.focusSoft],
      ];
      for (const [foreground, background] of pairs) {
        expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
