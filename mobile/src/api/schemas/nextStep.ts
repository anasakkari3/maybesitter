import { z } from 'zod';
import { isoDateTime } from './common';

const assignmentSchema = z.object({
  experimentId: z.string(),
  arm: z.string(),
  enabled: z.boolean(),
});

const exposureSchema = z.object({
  allowed: z.boolean(),
  reason: z.string(),
});

/**
 * The recommendation object, mirroring `nextStep.recommendation.json`.
 *
 * It is kept whole rather than reduced to a `proposalId`, because the decision
 * endpoint echoes the *entire* proposal back (`lib/services/mobile/
 * pilotService.ts` `proposalFrom`), and the server refuses a decision whose
 * proposal is no longer the live one with a 409. #157's own table says
 * "`proposalId`"; the service says otherwise, and the service is the contract.
 */
export const nextStepRecommendationSchema = z.object({
  version: z.string(),
  proposalId: z.string(),
  state: z.string(),
  locale: z.string(),
  primaryStep: z
    .object({ commitmentId: z.string(), title: z.string() })
    .nullable()
    .optional(),
  explanation: z
    .object({
      /**
       * English, server-composed, and never shown: the quality harness and the
       * trace recorder match on it. The phone reads `evidenceCodes`.
       */
      summary: z.string(),
      evidenceLabels: z.array(z.string()),
      /**
       * `code` stays a plain string rather than an enum on purpose: a server
       * that learns a new reason must not make the whole response unparseable
       * on an older build. `evidencePhrase` renders the ones it knows and
       * drops the rest, which is the only safe way to fail here — the
       * alternative is a raw enum on a user's screen.
       */
      evidenceCodes: z
        .array(z.object({
          code: z.string(),
          params: z.object({
            level: z.enum(['low', 'normal', 'high']).optional(),
            minutes: z.number().optional(),
          }).optional(),
        }))
        .optional(),
      sensitiveInferenceUsed: z.boolean(),
    })
    // `null`, not merely absent: `nextStepReviewService` sets `explanation:
    // null` on both the `empty` and `insufficient_evidence` states. Declared
    // optional-only, this schema rejected every response that was not a live
    // suggestion — so the two states the card exists to render could never
    // reach it. Found by the card's own tests (#173).
    .nullable()
    .optional(),
  availableActions: z.array(z.string()).optional(),
  persistence: z
    .object({ occurred: z.boolean(), confirmationRequired: z.boolean() })
    .optional(),
});

export type NextStepRecommendation = z.infer<typeof nextStepRecommendationSchema>;

export const nextStepResponseSchema = z.object({
  success: z.boolean(),
  participantId: z.string(),
  recommendation: nextStepRecommendationSchema,
  assignment: assignmentSchema.optional(),
  exposure: exposureSchema.optional(),
});

export const nextStepDecisionResponseSchema = z.object({
  success: z.boolean(),
  replayed: z.boolean(),
  participantId: z.string(),
  assignment: assignmentSchema.optional(),
  outcome: z.object({
    status: z.string(),
    decision: z.object({
      version: z.string(),
      proposalId: z.string(),
      decision: z.enum(['accept', 'edit', 'defer', 'dismiss', 'done']),
      decidedAt: isoDateTime,
    }),
    persisted: z.boolean(),
  }),
});

export type NextStepDecisionKind = 'accept' | 'edit' | 'defer' | 'dismiss' | 'done';
