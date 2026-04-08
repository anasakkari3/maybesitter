const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function timeText(date: Date): string {
  let hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const suffix = hours >= 12 ? 'PM' : 'AM';
  hours %= 12;
  if (hours === 0) hours = 12;
  return minutes === 0
    ? `${hours} ${suffix}`
    : `${hours}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

export function formatDisplayTime(value: string | null | undefined, now = new Date()): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;

  const date = new Date(timestamp);
  const dayDiff = Math.round((startOfUtcDay(date) - startOfUtcDay(now)) / (24 * 60 * 60 * 1000));
  const clock = timeText(date);

  if (dayDiff === 0) return `today at ${clock}`;
  if (dayDiff === 1) return `tomorrow at ${clock}`;
  if (dayDiff === -1) return `yesterday at ${clock}`;

  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} at ${clock}`;
}

export function formatDisplayDate(value: string | null | undefined, now = new Date()): string | null {
  const formatted = formatDisplayTime(value, now);
  if (!formatted) return null;
  return formatted.replace(/\s+at\s+\d{1,2}(?::\d{2})?\s(?:AM|PM)$/i, '');
}
