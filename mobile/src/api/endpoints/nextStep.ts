import { apiRequest } from '../client';
import {
  nextStepDecisionResponseSchema,
  nextStepResponseSchema,
  type NextStepDecisionKind,
  type NextStepRecommendation,
} from '../schemas/nextStep';

export function getNextStep(locale: string) {
  return apiRequest('GET', '/api/mobile/recommendations/next-step', {
    query: { locale },
    schema: nextStepResponseSchema,
  });
}

/**
 * Records what the user did with the proposal.
 *
 * `proposal` is the **whole recommendation object**, echoed back. #157's table
 * describes a bare `proposalId`; the service reads `input.proposal` and then
 * compares it against the live proposal, answering 409 when they differ
 * (`lib/services/mobile/pilotService.ts`). Sending only an id is the
 * regression the fixture and this comment exist to prevent.
 *
 * `idempotencyKey` is generated once per user decision, not per attempt: it is
 * what makes a double tap one recorded decision rather than two.
 */
export function recordNextStepDecision(input: {
  locale: string;
  decision: NextStepDecisionKind;
  proposal: NextStepRecommendation;
  idempotencyKey: string;
  editedTitle?: string;
  /** When a deferred step becomes eligible again (UC-2.9, #170). */
  deferUntil?: string;
}) {
  return apiRequest('POST', '/api/mobile/recommendations/next-step/actions', {
    body: {
      locale: input.locale,
      decision: input.decision,
      proposal: input.proposal,
      idempotencyKey: input.idempotencyKey,
      ...(input.editedTitle ? { editedTitle: input.editedTitle } : {}),
      ...(input.deferUntil ? { deferUntil: input.deferUntil } : {}),
    },
    schema: nextStepDecisionResponseSchema,
  });
}
