import type { CaptureProposalItem } from '../../api/schemas/capture';
import type { CaptureItemEdit } from './captureMachine';
import { dayKey, formatDayKey, formatTime, formatTimeRange } from '../../i18n/format';
import { isolateAuto, stripIsolates } from '../../i18n/bidi';
import { fill, ltr, type Lang, type Strings } from '../../i18n/strings';

export type ChatItemConflict = NonNullable<CaptureProposalItem['conflicts']>[number];

/**
 * The chat card's clash lines (owner request 2026-09-30: "the agent cannot
 * describe what the commitment is if there is a collision").
 *
 * One line per clash the server found at proposal time, naming it in the
 * app's language: «بيتعارض مع «عرس ابن عمي» 18:00». A weekly block or the
 * calendar's busy time holds a stretch, so it reads as a range; a commitment
 * or a match reads as its start. The day is said only when it is not the
 * card's own day (a block that began the evening before).
 *
 * The calendar's busy time has no title, and gets none: it reads as the
 * device chip's own sentence («بيتقاطع مع موعد بتقويمك …»), and not at all
 * when that chip (`BusyConflictChip`, the phone's calendar and Google's) is
 * already saying it for the same hour.
 *
 * Nothing when the person has moved the time on the card: the server measured
 * the clash at the time it proposed, and a line about the old hour under the
 * new one would be wrong.
 */
export function chatConflictLines(
  item: Pick<CaptureProposalItem, 'conflicts' | 'resolvedTime' | 'resolvedDate'>,
  edit: CaptureItemEdit | undefined,
  options: { lang: Lang; timezone: string; t: Strings; busyChipShown: boolean; now?: Date },
): string[] {
  if (edit?.localDateTime !== undefined) return [];
  const { lang, timezone, t } = options;
  const format = { locale: lang, timeZone: timezone };
  const itemDay = item.resolvedTime ? dayKey(new Date(item.resolvedTime), timezone) : item.resolvedDate;
  let busySaid = options.busyChipShown;
  const lines: string[] = [];
  for (const conflict of item.conflicts ?? []) {
    const start = new Date(conflict.startsAt);
    const end = new Date(conflict.endsAt);
    const ranged = conflict.kind === 'weekly' || conflict.kind === 'calendar_busy';
    const clock = ranged ? formatTimeRange(start, end, format) : ltr(formatTime(start, format));
    const day = dayKey(start, timezone);
    const when = day === itemDay
      ? clock
      : `${isolateAuto(formatDayKey(day, { ...format, ...(options.now ? { now: options.now } : {}) }))} · ${clock}`;
    if (conflict.title === null) {
      if (busySaid) continue;
      busySaid = true;
      lines.push(fill(t.calendarBusyConflict, { range: when }));
    } else {
      lines.push(fill(t.chatConflictWith, { title: isolateAuto(conflict.title), when }));
    }
  }
  return lines;
}

/** A clash line as a screen reader says it: the same words, without the direction marks. */
export function chatConflictA11y(line: string): string {
  return stripIsolates(line);
}
