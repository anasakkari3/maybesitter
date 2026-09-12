import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { z } from 'zod';
import { commitmentListSchema, commitmentSchema, errorBodySchema, importanceOf } from '../schemas/common';
import {
  commitmentActionResultSchema,
  commitmentDeleteResultSchema,
  invalidTransitionSchema,
  staleCommitmentSchema,
} from '../schemas/commitments';
import { captureConfirmationSchema, captureProposalSchema } from '../schemas/capture';
import { nextStepDecisionResponseSchema, nextStepResponseSchema } from '../schemas/nextStep';
import { trustResponseSchema } from '../schemas/trust';
import { alphaFeedbackSchema, feedbackHistorySchema, feedbackRevokeSchema } from '../schemas/feedback';
import { analyticsAckSchema } from '../schemas/analytics';

/**
 * The drift detector.
 *
 * Every fixture in `../__fixtures__/` was written by
 * `tests/mobile/exportMobileApiFixtures.test.ts`, which invokes the real route
 * handlers in-process. If the backend changes a response, that test rewrites
 * the fixture and this one fails — in CI, before a user's screen does.
 *
 * The last case is the one that makes the rest hold: every fixture must be
 * claimed by a schema. A new endpoint whose fixture nobody parses would
 * otherwise sit there looking like coverage.
 */

const FIXTURES = join(__dirname, '..', '__fixtures__');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

const CASES: Array<[string, z.ZodType]> = [
  ['capture.proposal', captureProposalSchema],
  ['capture.confirmation', captureConfirmationSchema],
  ['capture.confirmationFailed', captureConfirmationSchema],
  ['commitments.today', commitmentListSchema],
  ['commitments.upcoming', commitmentListSchema],
  ['commitments.one', commitmentSchema],
  ['commitments.patched', commitmentSchema],
  ['commitments.action', commitmentActionResultSchema],
  ['commitments.deleted', commitmentDeleteResultSchema],
  ['commitments.notFound', errorBodySchema],
  ['commitments.stale', staleCommitmentSchema],
  ['commitments.invalidTransition', invalidTransitionSchema],
  ['nextStep.recommendation', nextStepResponseSchema],
  ['nextStep.decision', nextStepDecisionResponseSchema],
  ['trust.state', trustResponseSchema],
  ['trust.updated', trustResponseSchema],
  ['feedback.history', feedbackHistorySchema],
  ['feedback.revoked', feedbackRevokeSchema],
  ['alphaFeedback.flag', alphaFeedbackSchema],
  ['analytics.ack', analyticsAckSchema],
  ['errors.unauthorized', errorBodySchema],
];

describe('every response the client parses', () => {
  it.each(CASES)('%s matches its schema', (name, schema) => {
    const result = schema.safeParse(fixture(name));
    expect(result.success ? [] : result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)).toEqual([]);
  });

  it('has a schema for every fixture on disk', () => {
    const onDisk = readdirSync(FIXTURES)
      .filter(name => name.endsWith('.json'))
      .map(name => name.replace(/\.json$/, ''))
      .sort();
    expect(onDisk).toEqual(CASES.map(([name]) => name).sort());
  });
});

describe('what the schemas assert about the shape', () => {
  it('reads a confirmation failure from the body as well as the status', () => {
    const failed = captureConfirmationSchema.parse(fixture('capture.confirmationFailed'));
    // Before #252 this exact body came back with HTTP 200 and `success` was
    // the only signal — and the client did not read it. Both are checked now.
    expect(failed.success).toBe(false);
    expect(failed.failureCode).toBe('proposal_not_found');
    expect(failed.persisted).toEqual([]);
    expect(failed.failed[0]?.reason).toBe('proposal_not_found');
  });

  it('keeps the whole recommendation, because the decision endpoint echoes it', () => {
    const response = nextStepResponseSchema.parse(fixture('nextStep.recommendation'));
    // A client that kept only the id could not satisfy `proposalFrom` in
    // pilotService, which reads `input.proposal` as an object.
    expect(typeof response.recommendation).toBe('object');
    expect(response.recommendation.proposalId).toEqual(expect.any(String));
    expect(response.recommendation.state).toBe('ready');
  });

  it('carries the newer commitment in a stale-edit refusal', () => {
    const stale = staleCommitmentSchema.parse(fixture('commitments.stale'));
    // The point of the 409: the client can show what the other device did,
    // rather than only that its own edit was refused.
    expect(stale.current.id).toEqual(expect.any(String));
    expect(stale.current.status).toBe('completed');
  });

  it('does not describe the conflicts with errorBodySchema', () => {
    // These refusals carry `reason` and no `error`, unlike every other one.
    // A schema that claimed otherwise would fail on the wire, not in CI.
    expect(errorBodySchema.safeParse(fixture('commitments.stale')).success).toBe(false);
    expect(errorBodySchema.safeParse(fixture('commitments.invalidTransition')).success).toBe(false);
  });

  it('maps server priority levels onto the design three', () => {
    const commitment = commitmentSchema.parse(fixture('commitments.one'));
    expect(importanceOf(commitment)).toBe('should');
    expect(importanceOf({ ...commitment, priority: { ...commitment.priority, level: 'high' } })).toBe('must');
    expect(importanceOf({ ...commitment, priority: { ...commitment.priority, level: 'low' } })).toBe('nice');
  });

  it('refuses a response that lost a field', () => {
    const { items, ...withoutItems } = fixture('commitments.today') as { items: unknown };
    expect(commitmentListSchema.safeParse(withoutItems).success).toBe(false);
    expect(items).toBeDefined();
  });

  it('accepts a response that gained one, so an older client keeps working', () => {
    const extended = { ...(fixture('commitments.one') as object), somethingNew: true };
    expect(commitmentSchema.safeParse(extended).success).toBe(true);
  });
});
