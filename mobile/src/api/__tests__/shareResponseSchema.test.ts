/**
 * The share response schema refuses what a compromised server would send
 * (UC-3.9, #193 step 7).
 *
 * ── Why the client checks at all ─────────────────────────────────
 *
 * `lib/services/share/shareAllowlist.ts` already rebuilds the response out of
 * declared fields on the server. This is the second, independent enforcement
 * #193 asks for: the control is "schema plus action allowlist, enforced in code
 * on server and client, independent of the model". A control with one
 * implementation is a control with one bug away from nothing.
 *
 * ── The fixture is the real shape, with one thing changed ────────
 *
 * The base object below is `capture.shareProposal.json` — generated from the
 * real handler by `tests/mobile/exportMobileApiFixtures.test.ts` — and each
 * case changes exactly one thing about it. A hand-written "compromised
 * response" that the server could never emit would make every assertion here a
 * claim about the test's own imagination.
 */
import { describe, expect, it } from '@jest/globals';
import { shareProposalSchema } from '../schemas/share';
import fixture from '../__fixtures__/capture.shareProposal.json';

/** A deep clone, so one case cannot leak into the next. */
function base(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
}

describe('the share response schema', () => {
  it('parses the generated fixture unchanged', () => {
    expect(() => shareProposalSchema.parse(base())).not.toThrow();
  });

  it('refuses an unknown field on the envelope', () => {
    const body = base();
    (body.share as Record<string, unknown>).confirmed = true;
    expect(shareProposalSchema.safeParse(body).success).toBe(false);
  });

  it('refuses an action the product cannot take', () => {
    const body = base();
    (body.share as Record<string, unknown>).suggestedNextAction = {
      kind: 'send_message',
      itemId: 'item-0',
    };
    expect(shareProposalSchema.safeParse(body).success).toBe(false);
  });

  it('refuses an extra field smuggled into the next action', () => {
    const body = base();
    (body.share as Record<string, unknown>).suggestedNextAction = {
      kind: 'review',
      itemId: 'item-0',
      action: 'delete_all',
    };
    expect(shareProposalSchema.safeParse(body).success).toBe(false);
  });

  it('refuses the whole compromised-stub answer #193 step 6 describes', () => {
    const body = base();
    body.action = 'delete_all';
    (body.share as Record<string, unknown>).confirmed = true;
    (body.share as Record<string, unknown>).suggestedNextAction = {
      kind: 'send_message',
      itemId: 'item-0',
    };
    expect(shareProposalSchema.safeParse(body).success).toBe(false);
  });

  it('still refuses when only the envelope is touched, so the refusal is this schema', () => {
    // The base parses and the same object with one added envelope key does not.
    // Without this pair, a schema that rejected the fixture outright would pass
    // every case above.
    const clean = base();
    expect(shareProposalSchema.safeParse(clean).success).toBe(true);
    (clean.share as Record<string, unknown>).nextAction = 'delete_all';
    expect(shareProposalSchema.safeParse(clean).success).toBe(false);
  });
});
