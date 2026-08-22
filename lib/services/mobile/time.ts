export const DEFAULT_MOBILE_TIMEZONE = 'Asia/Jerusalem';

export function parseIsoDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty ISO date string`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${field} must be a valid ISO date string`);
  }
  return parsed;
}

/** A datetime that names its own offset, or a bare calendar date. */
const CARRIES_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a client-supplied timestamp into an unambiguous instant.
 *
 * `new Date('2026-08-23T15:00:00')` resolves an offset-less datetime against
 * whatever zone the *server* runs in. The same request therefore stored a
 * different instant on a developer's machine than on a UTC host — an
 * Asia/Jerusalem user's times drifted three hours the moment the backend was
 * deployed anywhere, and the drift was invisible locally because the dev
 * server shares the device's zone.
 *
 * An offset-less datetime is read as UTC: deterministic everywhere, and it
 * matches what clients that send `…Z` already mean. Values that name an offset
 * keep it, and a bare date keeps the UTC midnight `Date` already gave it.
 */
export function parseIsoInstant(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty ISO date string`);
  }
  const raw = value.trim();
  const normalized =
    CARRIES_OFFSET.test(raw) || DATE_ONLY.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${field} must be a valid ISO date string`);
  }
  return parsed;
}

export function dateFromOptionalIso(value: unknown, fallback: Date, field: string): Date {
  if (value === undefined || value === null || value === '') return fallback;
  return parseIsoDate(value, field);
}

export function normalizeTimezone(value: unknown): string {
  const timezone = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_MOBILE_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return DEFAULT_MOBILE_TIMEZONE;
  }
}

export function localDayKey(value: string | Date, timezone: string): string {
  const date = typeof value === 'string' ? parseIsoDate(value, 'date') : value;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Could not resolve local day');
  return `${year}-${month}-${day}`;
}

export function resolvedCommitmentTime(commitment: {
  timeSpec: { dueAt: string | null; remindAt: string | null };
  postponedUntil?: string | null;
}): string | null {
  return commitment.postponedUntil || commitment.timeSpec.remindAt || commitment.timeSpec.dueAt;
}
