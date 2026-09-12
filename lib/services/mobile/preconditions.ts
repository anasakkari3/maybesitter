/**
 * Optimistic concurrency for commitment edits (UC-1.4, #148).
 *
 * Two devices on one account is the normal case, not the exception: a phone
 * completes a commitment while a tablet has the old copy open, and the tablet's
 * edit would otherwise overwrite it with no one noticing. So a single
 * commitment read carries an `ETag`, and a mutation may carry that value back
 * as `If-Match`. The server refuses when the commitment has moved since.
 *
 * ── The validator is `updatedAt` ─────────────────────────────────
 *
 * Not a hash of the body, and not a separate version counter. `updatedAt` is
 * already on every commitment, is already written by every transition, and is
 * already in the DTO the client holds — so the client can produce the validator
 * from the object it is editing, without the server inventing a second notion
 * of "current".
 *
 * ── Absent `If-Match` still works ────────────────────────────────
 *
 * A mutation without the header is unconditional, which is what every client
 * did before this and what a first write still does. The header opts in to the
 * check; it is not a new requirement.
 */
import type { Commitment } from '../../../src/domain/stateMachine';
import { commitmentValidator } from './commitmentValidator';
import { commitmentToMobileDto } from './response';

/** The validator for a commitment, quoted as an HTTP entity-tag. */
export function etagFor(commitment: Commitment): string {
  return `"${commitmentValidator(commitment)}"`;
}

/**
 * The `updatedAt` an `If-Match` header is asserting, or undefined for an
 * unconditional request.
 *
 * `*` means "any current representation", which every existing commitment
 * satisfies, so it is treated as unconditional rather than as a literal
 * validator. A weak validator (`W/"…"`) is accepted and unwrapped: weakness is
 * about byte-for-byte equality of a representation, and this compares a
 * timestamp.
 */
export function ifMatchFrom(request: { headers: Headers }): string | undefined {
  const raw = request.headers.get('if-match');
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value === '' || value === '*') return undefined;
  // Only the first tag is honoured: a list means "any of these", and this
  // resource has exactly one current validator, so a list is a client error
  // waiting to happen rather than something to guess at.
  const first = value.split(',')[0]!.trim();
  const unwrapped = first.startsWith('W/') ? first.slice(2).trim() : first;
  return unwrapped.startsWith('"') && unwrapped.endsWith('"') && unwrapped.length >= 2
    ? unwrapped.slice(1, -1)
    : unwrapped;
}

/**
 * 409 with the commitment as it actually is.
 *
 * The current DTO is the point: the client has to be able to show the newer
 * state, which is the difference between "your edit was refused" and "somebody
 * else changed this, here it is".
 */
export function staleCommitmentResponse(current: Commitment): Response {
  return Response.json(
    {
      success: false,
      reason: 'stale_commitment',
      current: commitmentToMobileDto(current),
    },
    { status: 409, headers: { ETag: etagFor(current) } },
  );
}

/** 409: the state machine refused the move, whatever the caller expected. */
export function invalidTransitionResponse(): Response {
  return Response.json({ success: false, reason: 'invalid_transition' }, { status: 409 });
}
