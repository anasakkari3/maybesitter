/**
 * Cutting a title at its bound without splitting a character (M3b).
 *
 * The server counts two ways: habit and goal titles in code points
 * (`Array.from`), commitment edits in UTF-16 units (`String.length`, the
 * confirm's `CAPTURE_EDIT_TITLE_MAX`). Neither cut may leave half of a
 * surrogate pair behind.
 */
export function clampCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join('');
}

export function clampUnits(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = '';
  for (const point of value) {
    if (out.length + point.length > max) break;
    out += point;
  }
  return out;
}
