/**
 * Chips that write into a text field, and combine (closure CL2b, complaint #3).
 *
 * ── The field is the truth ───────────────────────────────────────
 *
 * A chip is a starter the user can keep, add to, or type over, so there is no
 * separate "selected" list to drift from what the field says. A chip is lit
 * exactly when its words stand in the field as a whole item of the list —
 * between the start or a comma and the end or a comma — and tapping it either
 * appends it after whatever is there or takes it back out.
 *
 * So the answer reads as the chips in the order they were tapped, joined with
 * the language's list comma («، » in Arabic), with anything typed kept where it
 * was typed. Some chip labels contain a comma themselves («بفيق بكير، وصبحي
 * مشغول»): matching is on the whole label, never on split pieces, so those
 * stay one chip.
 */
import type { Lang } from '../i18n/strings';

/** The comma a list is joined with, and the space after it. */
export function chipSeparator(lang: Lang): string {
  return lang === 'ar' ? '، ' : ', ';
}

const COMMA = /[,،]$/;
const LEADING_COMMA = /^[,،]/;

/** Where `label` stands as a whole list item in `text`, or -1. */
function itemIndex(text: string, label: string): number {
  if (label === '') return -1;
  let from = 0;
  for (;;) {
    const at = text.indexOf(label, from);
    if (at < 0) return -1;
    const before = text.slice(0, at).trimEnd();
    const after = text.slice(at + label.length).trimStart();
    if ((before === '' || COMMA.test(before)) && (after === '' || LEADING_COMMA.test(after))) return at;
    from = at + 1;
  }
}

/** Whether the chip's words stand in the field as one of its items. */
export function hasChip(text: string, label: string): boolean {
  return itemIndex(text, label) >= 0;
}

/**
 * The field after tapping the chip: without it when it was there, otherwise
 * with it added at the end. One comma goes with it either way, so the list
 * never keeps a dangling separator.
 */
export function toggleChip(text: string, label: string, separator: string): string {
  const at = itemIndex(text, label);
  if (at < 0) {
    const kept = text.trimEnd();
    if (kept === '') return label;
    return COMMA.test(kept) ? `${kept} ${label}` : `${kept}${separator}${label}`;
  }
  const before = text.slice(0, at).trimEnd();
  const after = text.slice(at + label.length).trimStart();
  if (LEADING_COMMA.test(after)) {
    // "a, LABEL, c" → "a, c"; "LABEL, c" → "c".
    const rest = after.slice(1).trimStart();
    return before === '' ? rest : `${before} ${rest}`.trim();
  }
  // The last item: its comma is the one before it.
  return before.replace(COMMA, '').trimEnd();
}
