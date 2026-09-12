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
      summary: z.string(),
      evidenceLabels: z.array(z.string()),
      sensitiveInferenceUsed: z.boolean(),
    })
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
