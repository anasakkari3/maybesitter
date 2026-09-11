/**
 * The `users/{uid}` document (UC-1.0b, #141).
 *
 * One document per person, holding what is small, single-valued and read on
 * almost every request: locale, timezone, the trust record and the domain
 * version. Everything that grows — commitments, reminders, events — lives in a
 * subcollection instead, because a document has a 1 MiB ceiling and a user who
 * keeps using the product would eventually hit it.
 *
 * `trust` is generic so this module does not have to import `lib/pilot`: the
 * storage layer owns the shape of the envelope, the pilot controls own the
 * shape of the trust record inside it.
 */
export const USER_SCHEMA_VERSION = 1;

export type UserLocale = 'ar' | 'he' | 'en';

export interface UserDocument<TTrust = unknown> {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  locale: UserLocale | null;
  timezone: string | null;
  trust: TTrust | null;
  /**
   * Incremented once per committed domain transaction. It is the number a test
   * — or an operator — can use to tell "twenty writes landed" from "twenty
   * writes raced and four of them were lost".
   */
  domainVersion: number;
}

export function newUserDocument(at: string): UserDocument {
  return {
    schemaVersion: USER_SCHEMA_VERSION,
    createdAt: at,
    updatedAt: at,
    locale: null,
    timezone: null,
    trust: null,
    domainVersion: 0,
  };
}
