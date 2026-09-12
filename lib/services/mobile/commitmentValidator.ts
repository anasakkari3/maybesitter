/**
 * The validator a commitment edit is checked against (UC-1.4, #148).
 *
 * ── Why not `updatedAt` alone ────────────────────────────────────
 *
 * `updatedAt` is the obvious choice and was the first one here. It is wrong by
 * a millisecond: every transition stamps `updatedAt = command.now`, so two
 * changes inside the same millisecond produce the same value, and a device
 * holding the copy from *before* both of them would have its stale write
 * accepted. That is not hypothetical — creating a commitment and editing it in
 * one test run collides every time, and on a warm server a retry can land in
 * the same millisecond as the request it is retrying.
 *
 * So the validator is `updatedAt` plus a digest of the commitment itself. It
 * still reads as a timestamp, it still changes on every change, and it no
 * longer depends on the clock being finer-grained than the work.
 *
 * ── Why the digest is canonical ──────────────────────────────────
 *
 * The same commitment must produce the same validator on every instance. A
 * document that has been through Firestore can come back with its keys in a
 * different order than the one that wrote it, and `JSON.stringify` would then
 * hash the same commitment two ways — an ETag that changes when nothing did,
 * and a 409 for an edit that should have been accepted. Keys are sorted before
 * hashing so the digest describes the value rather than its spelling.
 *
 * Clients never build this. They echo what the server sent them, so its shape
 * is ours to change.
 */
import { createHash } from 'node:crypto';
import type { Commitment } from '../../../src/domain/stateMachine';

/** JSON with object keys in a fixed order, at every depth. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

/**
 * The opaque validator for a commitment's current state.
 *
 * Twelve hex characters of SHA-256 is 48 bits. A collision would need two
 * different states of the *same* commitment in the *same* millisecond hashing
 * alike, which is not a risk worth a longer header.
 */
export function commitmentValidator(commitment: Commitment): string {
  const digest = createHash('sha256').update(canonical(commitment)).digest('hex').slice(0, 12);
  return `${commitment.updatedAt}.${digest}`;
}
