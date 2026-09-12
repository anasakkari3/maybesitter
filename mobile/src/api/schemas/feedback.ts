import { z } from 'zod';
import { isoDateTime } from './common';

const historyRowSchema = z.object({
  id: z.string(),
  outcome: z.string(),
  subjectId: z.string(),
  occurredAt: isoDateTime,
  revokedAt: isoDateTime.nullable(),
  canRevoke: z.boolean(),
});

/**
 * Mirrors `feedback.history.json`.
 *
 * #157's table lists `counters` and `lastUpdatedAt` here. The route does not
 * return them — the fixture is the proof — so the schema does not claim them.
 * Revoked rows stay in `rows`: they are the visible evidence that a correction
 * was applied, and dropping them would ask the user to take our word for it.
 */
export const feedbackHistorySchema = z.object({
  version: z.string(),
  rows: z.array(historyRowSchema),
  baselineNotice: z
    .object({ countedFrom: isoDateTime.nullable(), note: z.string() })
    .nullable()
    .optional(),
});

export type FeedbackHistoryRow = z.infer<typeof historyRowSchema>;

export const feedbackRevokeSchema = z.object({
  version: z.string(),
  success: z.boolean(),
  alreadyRevoked: z.boolean(),
  row: historyRowSchema,
});

/** Mirrors `alphaFeedback.flag.json`; the route answers 201. */
export const alphaFeedbackSchema = z.object({
  flagId: z.string(),
  category: z.enum([
    'recommendation_wrong',
    'misunderstood_me',
    'not_useful',
    'invasive',
    'technical_problem',
  ]),
});

export type AlphaFeedbackCategory = z.infer<typeof alphaFeedbackSchema>['category'];
