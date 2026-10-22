import type { Clash } from '../../api/schemas/m4b';
import { dayKey, formatDayKey, formatTime, formatTimeRange } from '../../i18n/format';
import { isolateAuto } from '../../i18n/bidi';
import { fill, ltr, type Lang, type Strings } from '../../i18n/strings';
import { unbreakableRange } from '../calendar/busyConflictText';

/**
 * One clash as a line (M4b R1.5), the capture card's own wording
 * (`chatConflictLines`): «بيتعارض مع «عشا العيلة» 20:00». A weekly block or
 * calendar busy time holds a stretch, so it reads as a range; a commitment or
 * a match reads as its start. The day is said only when it is not the
 * subject's own day. Calendar busy time has no title and gets none.
 */
export function clashLine(
  clash: Clash,
  options: { t: Strings; lang: Lang; timezone: string; subjectDay: string | null; now?: Date },
): string {
  const { t, lang, timezone } = options;
  const format = { locale: lang, timeZone: timezone };
  const start = new Date(clash.startsAt);
  const end = new Date(clash.endsAt);
  const ranged = clash.kind === 'weekly' || clash.kind === 'calendar_busy';
  const clock = ranged ? unbreakableRange(formatTimeRange(start, end, format)) : ltr(formatTime(start, format));
  const day = dayKey(start, timezone);
  const when = day === options.subjectDay
    ? clock
    : `${isolateAuto(formatDayKey(day, { ...format, ...(options.now ? { now: options.now } : {}) }))} · ${clock}`;
  return clash.title === null
    ? fill(t.calendarBusyConflict, { range: when })
    : fill(t.chatConflictWith, { title: isolateAuto(clash.title), when });
}
