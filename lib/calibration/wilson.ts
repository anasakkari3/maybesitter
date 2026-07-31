/**
 * Wilson score interval at 95%.
 *
 * The first calibration round reported bare agreement rates over 10 items. At
 * that size a single item moves the rate by ten points, so a point estimate
 * alone invites over-reading. Every rate this module reports carries an
 * interval next to it.
 */
const Z_95 = 1.959963984540054;

export function wilsonInterval(
  successes: number,
  trials: number,
  z: number = Z_95,
): readonly [number, number] | null {
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) return null;
  if (trials <= 0 || successes < 0 || successes > trials) return null;

  const proportion = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = proportion + (z * z) / (2 * trials);
  const spread = z * Math.sqrt((proportion * (1 - proportion)) / trials + (z * z) / (4 * trials * trials));

  const lower = (centre - spread) / denominator;
  const upper = (centre + spread) / denominator;

  return [clampUnit(lower), clampUnit(upper)];
}

function clampUnit(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(6));
}
