import { apiRequest } from '../client';
import { captureProposalResponseSchema } from '../schemas/capture';
import { heldFixtureDecidedSchema } from '../schemas/football';
import {
  heldItemsSchema,
  m4bCapabilitiesSchema,
  postponeSlotsSchema,
  type HeldItems,
  type M4bCapabilities,
  type PostponeSlots,
  type Readiness,
} from '../schemas/m4b';

/**
 * M4b's calls (WIRE-M4b). The capability probe exists in every environment
 * and answers all-false when a capability is off; every other route answers
 * 404 when its capability is off, which the screens read as "today's
 * behaviour".
 */
/** `asUid` on every call (M4B-A-R2-012): a request started for one account is never sent as another. */
type Bound = { asUid?: string };
const bound = (options: Bound) => (options.asUid !== undefined ? { asUid: options.asUid } : {});

export function getM4bCapabilities(options: Bound = {}): Promise<M4bCapabilities> {
  return apiRequest('GET', '/api/mobile/capabilities/m4b', { schema: m4bCapabilitiesSchema, ...bound(options) });
}

/** Up to three real free times to postpone a commitment to (R3.1). Read-only. */
export function getPostponeSlots(commitmentId: string, options: Bound = {}): Promise<PostponeSlots> {
  return apiRequest('GET', `/api/mobile/commitments/${encodeURIComponent(commitmentId)}/postpone-slots`, {
    schema: postponeSlotsSchema,
    ...bound(options),
  });
}

/**
 * «ضيفه» / «مش هاد الماتش» on a held match (R1.3). `heldVersion` names the
 * hold the person saw; a hold that changed since is a `HeldChangedError`.
 */
export function decideHeldFixture(
  fixtureId: string,
  action: 'add' | 'dismiss',
  heldVersion: string,
  clientActionId: string,
  options: Bound = {},
) {
  return apiRequest('POST', `/api/mobile/football/held/${encodeURIComponent(fixtureId)}`, {
    body: { action, expectedHeldVersion: heldVersion, clientActionId },
    schema: heldFixtureDecidedSchema,
    ...bound(options),
  });
}

/** What «يتابع لك» counts: clash-held matches and feed rows (R1.3). */
export function getHeldItems(options: Bound = {}): Promise<HeldItems> {
  return apiRequest('GET', '/api/mobile/held-items', { schema: heldItemsSchema, ...bound(options) });
}

/**
 * «حاضر؟» answered on a capture card (R2.2). The answer comes back as the
 * proposal itself, with a preparation item added for «لسا لا» / «مش متأكد».
 */
export function answerImpact(input: { proposalId: string; revision: number; itemId: string; readiness: Readiness }, options: Bound = {}) {
  return apiRequest('POST', '/api/mobile/capture/impact', { body: input, schema: captureProposalResponseSchema, ...bound(options) });
}
