import { z } from 'zod';

/**
 * What this account has agreed to (UC-2.1 #161, UC-2.9 #170).
 *
 * Mirrors `consents.view.json`, which `tests/mobile/exportMobileApiFixtures.test.ts`
 * writes by calling the real route. The shape is therefore checked rather than
 * assumed — three of #157's hand-written shapes were wrong.
 */
const consentViewSchema = z.object({
  state: z.enum(['granted', 'declined']),
  version: z.string(),
  /** Empty string when never answered. */
  changedAt: z.string(),
  /**
   * Whether the question has ever been put to this person.
   *
   * The difference between "declined" and "never asked" is the difference
   * between respecting an answer and never having had one, and the composer's
   * chip must not present the second as the first.
   */
  asked: z.boolean(),
});

export const consentsViewSchema = z.object({
  aiProcessing: consentViewSchema,
  recommendations: consentViewSchema,
  currentVersions: z.object({ aiProcessing: z.string(), recommendations: z.string() }),
  /** #161's shape, kept so a client written against it keeps working. */
  currentVersion: z.string().optional(),
});

export type ConsentsView = z.infer<typeof consentsViewSchema>;
export type ConsentView = z.infer<typeof consentViewSchema>;

/**
 * The reply to a `PUT` (UC-2.R1, #171). The record without `asked` — the
 * question was self-evidently just asked, and the route does not send it.
 */
export const consentStateSchema = z.enum(['granted', 'declined']);

const consentRecordSchema = consentViewSchema.omit({ asked: true }).extend({
  locale: z.enum(['ar', 'he', 'en']).optional(),
  platform: z.enum(['ios', 'android']).optional(),
});

export const aiConsentUpdatedSchema = z.object({
  success: z.literal(true),
  aiProcessing: consentRecordSchema,
});

export const recommendationConsentUpdatedSchema = z.object({
  success: z.literal(true),
  recommendations: consentRecordSchema,
});

export type ConsentState = z.infer<typeof consentStateSchema>;
