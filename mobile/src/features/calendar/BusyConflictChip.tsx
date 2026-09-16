import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { formatTimeRange } from '../../i18n/format';
import { fill } from '../../i18n/strings';
import { Txt } from '../../ui/primitives';
import { chipBlock } from './conflicts';
import type { DeviceBusyBlock } from './busyBlocks';

/**
 * "You already have something then" (UC-3.2, #186 step 7).
 *
 * ── It is a note, not a warning ──────────────────────────────────
 *
 * Muted text on the surface colour, not the warm sand `wm` that "must" uses and
 * certainly not a red — there is nothing red anywhere in this product. Nothing
 * here disables a button. People double-book on purpose, they leave a lecture
 * early, and a product that argued with them about their own calendar would be
 * wrong more often than it was right.
 *
 * ── The times go through the locale, not through a template ──────
 *
 * `formatTimeRange` renders both ends in the user's locale and wraps them in
 * bidi isolates, so an Arabic line reads «بيتقاطع مع موعد بتقويمك ⁦14:00–15:30⁩»
 * with the range intact rather than with the two times swapped around the dash.
 * In Arabic the digits themselves may be Arabic-Indic, which is why nothing
 * anywhere near this chip pattern-matches on `\\d`.
 *
 * ── Two sentences, because an all-day entry has no times ─────────
 *
 * An all-day entry still counts as a hint — #186's decision — but "overlaps a
 * calendar event 00:00–00:00" is nonsense. `chipBlock` prefers a timed block
 * when there is one, and the all-day wording is used only when there is not.
 */
export function BusyConflictChip({
  blocks,
  testID,
}: {
  blocks: readonly DeviceBusyBlock[];
  testID: string;
}) {
  const { t, p, lang } = useApp();
  const timezone = useTimeZone();
  const block = chipBlock(blocks);
  if (block === null) return null;

  const label = block.allDay
    ? t.calendarBusyConflictAllDay
    : fill(t.calendarBusyConflict, {
      range: formatTimeRange(new Date(block.startAt), new Date(block.endAt), {
        locale: lang,
        timeZone: timezone,
      }),
    });

  return (
    <View style={{ backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10 }}>
      <Txt size={12} color={p.mu} testID={testID}>{label}</Txt>
    </View>
  );
}
