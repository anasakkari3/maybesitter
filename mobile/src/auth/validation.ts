/**
 * What the form refuses before it touches the network.
 *
 * Checking locally is not a security control — the server decides — it is how
 * a typo costs 0 ms instead of a round trip, and how a rate-limited account
 * does not burn an attempt on an address that is obviously not one.
 */
import type en from '../i18n/locales/en.json';

export type FieldErrorKey = Extract<keyof typeof en, `authField${string}`>;

/** Firebase's own floor. Shown before submitting so it is never a surprise. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Deliberately permissive: one `@`, something either side, no whitespace, and
 * a dot in the domain. A stricter pattern rejects real addresses, and the only
 * proof an address works is the mail arriving at it.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function emailError(value: string): FieldErrorKey | null {
  const trimmed = value.trim();
  if (trimmed === '') return 'authFieldEmailRequired';
  return EMAIL.test(trimmed) ? null : 'authFieldEmailInvalid';
}

export function passwordError(value: string): FieldErrorKey | null {
  if (value === '') return 'authFieldPasswordRequired';
  return value.length < MIN_PASSWORD_LENGTH ? 'authFieldPasswordShort' : null;
}

/** Addresses are compared and sent lower-cased and trimmed. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
