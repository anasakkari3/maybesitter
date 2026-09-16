import { createHash } from 'node:crypto';
import type { ActionGatewayRequest } from '../actions/actionGateway';

export const CONTROLLED_EMAIL_POLICY = Object.freeze({
  draftRequiresConfirmation: true,
  sendRequiresFreshReview: true,
  automaticSendAllowed: false,
  recipientChangeInvalidatesReview: true,
  contentChangeInvalidatesReview: true,
  rawContentInAuditAllowed: false,
});

export interface ControlledEmailDraft {
  readonly draftId: string;
  readonly scopeId: string;
  readonly provider: 'google' | 'microsoft';
  readonly connectionId: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly recipientDigest: string;
  readonly contentDigest: string;
  readonly createdAt: string;
}

export interface EmailReviewConfirmation {
  readonly draftId: string;
  readonly recipientDigest: string;
  readonly contentDigest: string;
  readonly confirmedAt: string;
  readonly expiresAt: string;
}

export type SendEmailRequestResult =
  | { readonly status: 'ready'; readonly request: ActionGatewayRequest<ControlledEmailDraft> }
  | {
    readonly status: 'review_required';
    readonly reason: 'missing_review' | 'review_target_changed' | 'review_expired';
  };

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function normalizedRecipients(values: readonly string[]): readonly string[] {
  return Object.freeze(Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))).sort());
}

export function createControlledEmailDraft(input: {
  readonly draftId: string;
  readonly scopeId: string;
  readonly provider: ControlledEmailDraft['provider'];
  readonly connectionId: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly createdAt: string;
}): ControlledEmailDraft {
  const to = normalizedRecipients(input.to);
  const cc = normalizedRecipients(input.cc ?? []);
  const bcc = normalizedRecipients(input.bcc ?? []);
  if (to.length + cc.length + bcc.length === 0) throw new Error('email draft requires a recipient');
  if (!input.subject.trim() && !input.body.trim()) throw new Error('email draft requires content');
  return Object.freeze({
    draftId: input.draftId,
    scopeId: input.scopeId,
    provider: input.provider,
    connectionId: input.connectionId,
    to,
    cc,
    bcc,
    subject: input.subject,
    body: input.body,
    recipientDigest: digest([...to, '--cc--', ...cc, '--bcc--', ...bcc]),
    contentDigest: digest([input.subject, input.body]),
    createdAt: input.createdAt,
  });
}

export function confirmEmailReview(input: {
  readonly draft: ControlledEmailDraft;
  readonly confirmedAt: string;
  readonly expiresAt: string;
}): EmailReviewConfirmation {
  const confirmedAt = Date.parse(input.confirmedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(confirmedAt) || !Number.isFinite(expiresAt) || expiresAt <= confirmedAt) {
    throw new Error('email review requires a valid future expiry');
  }
  return Object.freeze({
    draftId: input.draft.draftId,
    recipientDigest: input.draft.recipientDigest,
    contentDigest: input.draft.contentDigest,
    confirmedAt: input.confirmedAt,
    expiresAt: input.expiresAt,
  });
}

function gatewayRequest(
  capability: 'draft_email' | 'send_email',
  draft: ControlledEmailDraft,
  input: {
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestedAt: string;
  },
): ActionGatewayRequest<ControlledEmailDraft> {
  return {
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    scopeId: draft.scopeId,
    capability,
    provider: draft.provider,
    actor: 'user',
    userConfirmed: true,
    strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: false,
    payloadDigest: digest([capability, draft.recipientDigest, draft.contentDigest]),
    requestedAt: input.requestedAt,
    payload: draft,
  };
}

export function buildDraftEmailRequest(input: {
  readonly draft: ControlledEmailDraft;
  readonly review: EmailReviewConfirmation | null;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}): SendEmailRequestResult {
  const checked = validateReview(input.draft, input.review, input.requestedAt);
  if (checked) return checked;
  return { status: 'ready', request: gatewayRequest('draft_email', input.draft, input) };
}

export function buildSendEmailRequest(input: {
  readonly draft: ControlledEmailDraft;
  readonly review: EmailReviewConfirmation | null;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}): SendEmailRequestResult {
  const checked = validateReview(input.draft, input.review, input.requestedAt);
  if (checked) return checked;
  return { status: 'ready', request: gatewayRequest('send_email', input.draft, input) };
}

function validateReview(
  draft: ControlledEmailDraft,
  review: EmailReviewConfirmation | null,
  now: string,
): Exclude<SendEmailRequestResult, { readonly status: 'ready' }> | null {
  if (!review) return { status: 'review_required', reason: 'missing_review' };
  if (
    review.draftId !== draft.draftId
    || review.recipientDigest !== draft.recipientDigest
    || review.contentDigest !== draft.contentDigest
  ) {
    return { status: 'review_required', reason: 'review_target_changed' };
  }
  const nowMs = Date.parse(now);
  const expiresAt = Date.parse(review.expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return { status: 'review_required', reason: 'review_expired' };
  }
  return null;
}
