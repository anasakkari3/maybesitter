import type { CaptureProposalItem } from '../../api/schemas/capture';
import type { CaptureItemEdit } from './captureMachine';
import { dayKeptWithoutTime } from './noTimeDay';
import { instantForLocalDateTime } from './localInstant';
import { dayKey, formatDayKey, formatTime } from '../../i18n/format';
import { fill, ltr, type Lang, type Strings } from '../../i18n/strings';

/** Only server facts and explicit edits become schedule labels. No guessed duration. */
export function chatItemPresentation(item: CaptureProposalItem, edit: CaptureItemEdit | undefined,
  lang: Lang, timezone: string, t: Strings) {
  const instant = edit?.localDateTime !== undefined
    ? (edit.localDateTime ? instantForLocalDateTime(edit.localDateTime, timezone) : null)
    : item.resolvedTime ? new Date(item.resolvedTime) : null;
  const preservedDay = dayKeptWithoutTime(item, edit);
  const date = instant ? dayKey(instant, timezone)
    : preservedDay ?? (edit?.localDateTime === undefined ? item.resolvedDate : undefined);
  const dayLabel = date ? formatDayKey(date, { locale: lang, timeZone: timezone }) : undefined;
  const clock = instant ? ltr(formatTime(instant, { locale: lang, timeZone: timezone })) : undefined;
  const subtitle = instant ? (dayLabel && dayLabel !== t.today && dayLabel !== t.tomorrow ? `${dayLabel} · ${clock}` : clock!)
    : date && !item.eventOnDay && !item.allDayEvent && !item.needsClarification
      ? fill(t.reviewDueByDay, { day: formatDayKey(date, { locale: lang, timeZone: timezone }) })
      : dayLabel ? `${dayLabel} · ${t.noTimeYet}` : t.noTimeYet;
  return { title: edit?.title ?? item.title, date, instant, subtitle,
    priority: edit?.priority ?? item.priority,
    dateEstimated: Boolean(item.dateEstimated && date && edit?.localDateTime === undefined),
    timeEstimated: Boolean(item.timeEstimated && instant && edit?.localDateTime === undefined),
    priorityEstimated: Boolean(item.priorityEstimated && edit?.priority === undefined) };
}
