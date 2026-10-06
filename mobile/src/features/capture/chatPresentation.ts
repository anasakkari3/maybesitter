import type { CaptureProposalItem } from '../../api/schemas/capture';
import type { CaptureItemEdit } from './captureMachine';
import { dayKeptWithoutTime } from './noTimeDay';
import { instantForLocalDateTime } from './localInstant';
import { dayKey, formatDayKey, formatTime, formatTimeRange } from '../../i18n/format';
import { fill, ltr, type Lang, type Strings } from '../../i18n/strings';

/**
 * When a proposed item is, as the card shows it: the edit's time if the person
 * set one, the server's otherwise — and its end, when the server read one from
 * what was said («من 4 لـ 8», audit 2026-10-06 #2).
 *
 * A moved time keeps the range's length (the confirm's own rule: an edited
 * start shifts the end by the same duration), across midnight too; a cleared
 * time has no range. The schema already dropped an end that was not a real
 * instant after the start, so a missing end is simply a point.
 */
export function captureTimeOf(item: CaptureProposalItem, edit: CaptureItemEdit | undefined, timezone: string): {
  start: Date | null; end: Date | null;
} {
  const start = edit?.localDateTime !== undefined
    ? (edit.localDateTime ? instantForLocalDateTime(edit.localDateTime, timezone) : null)
    : item.resolvedTime ? new Date(item.resolvedTime) : null;
  if (!start || !item.endTime || !item.resolvedTime) return { start, end: null };
  const length = Date.parse(item.endTime) - Date.parse(item.resolvedTime);
  return { start, end: Number.isFinite(length) && length > 0 ? new Date(start.getTime() + length) : null };
}

/** «16:00» or «16:00–20:00»: one left-to-right unit either way. */
export function captureClock(start: Date, end: Date | null, lang: Lang, timezone: string): string {
  return end ? formatTimeRange(start, end, { locale: lang, timeZone: timezone })
    : ltr(formatTime(start, { locale: lang, timeZone: timezone }));
}

/** Only server facts and explicit edits become schedule labels. No guessed duration. */
export function chatItemPresentation(item: CaptureProposalItem, edit: CaptureItemEdit | undefined,
  lang: Lang, timezone: string, t: Strings) {
  const { start: instant, end } = captureTimeOf(item, edit, timezone);
  const preservedDay = dayKeptWithoutTime(item, edit);
  const date = instant ? dayKey(instant, timezone)
    : preservedDay ?? (edit?.localDateTime === undefined ? item.resolvedDate : undefined);
  const dayLabel = date ? formatDayKey(date, { locale: lang, timeZone: timezone }) : undefined;
  const clock = instant ? captureClock(instant, end, lang, timezone) : undefined;
  const subtitle = instant ? (dayLabel && dayLabel !== t.today && dayLabel !== t.tomorrow ? `${dayLabel} · ${clock}` : clock!)
    : date && !item.eventOnDay && !item.allDayEvent && !item.needsClarification
      ? fill(t.reviewDueByDay, { day: formatDayKey(date, { locale: lang, timeZone: timezone }) })
      : dayLabel ? `${dayLabel} · ${t.noTimeYet}` : t.noTimeYet;
  return { title: edit?.title ?? item.title, date, instant, end, subtitle,
    priority: edit?.priority ?? item.priority,
    dateEstimated: Boolean(item.dateEstimated && date && edit?.localDateTime === undefined),
    timeEstimated: Boolean(item.timeEstimated && instant && edit?.localDateTime === undefined),
    priorityEstimated: Boolean(item.priorityEstimated && edit?.priority === undefined) };
}
