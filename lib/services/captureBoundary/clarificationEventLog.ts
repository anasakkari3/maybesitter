import {
  CLARIFICATION_EVENTS,
  docIdForKey,
  getStorage,
  userCol,
  userIdForKey,
} from '../../storage';
import type { ClarificationAnsweredEvent } from './clarifyService';

/**
 * What the user answered when the capture asked its one question (UC-2.5,
 * #165).
 *
 * ── Why this exists at all ───────────────────────────────────────
 *
 * `answerClarification` has always ended by handing a `clarification_answered`
 * event to a port. Nothing ever implemented that port — not production, not a
 * test — and the call site was optional-chained, so for the whole life of the
 * feature the event was built and dropped on the floor with nothing able to go
 * red about it. This is the implementation, and the port is no longer optional
 * (see `ClarifyDependencies`), so a construction site that forgets it does not
 * compile.
 *
 * ── This is the user's own record, not analytics ─────────────────
 *
 * Written whatever the analytics consent says, for the reason
 * `nextStepDecisionLog` gives: it is the record of an answer a person gave
 * about their own commitment, it lives in their own tree, and it goes when
 * their account goes. Telemetry about clarifications is a separate thing that
 * belongs in `analyticsEvents` and is gated there.
 *
 * ── The words are never in it ────────────────────────────────────
 *
 * A free-text answer is the user's own sentence about their own life. What is
 * worth keeping is that they typed rather than tapped, and which field the
 * question was about. So the document is assembled field by field below rather
 * than spread from the event, which is what makes "the free text is not in
 * here" a property of this function instead of a promise about every caller.
 */
export interface ClarificationAnsweredRecord {
  type: 'clarification_answered';
  uid: string;
  proposalId: string;
  itemId: string;
  /** Which part of the capture was unclear: `time`, `date`, and so on. */
  field: string;
  answerKind: ClarificationAnsweredEvent['answerKind'];
  at: string;
}

/**
 * The document id.
 *
 * Derived from the answer rather than random, exactly as
 * `nextStepDecisionLog` derives its own: the same answer recorded twice — a
 * retry above the idempotency layer, a request the client sent again — is one
 * row instead of two, so the ledger cannot show somebody answering once and
 * having answered twice.
 */
function clarificationDocId(record: ClarificationAnsweredRecord): string {
  return docIdForKey(`${record.proposalId}:${record.itemId}:${record.answerKind}:${record.at}`);
}

/**
 * The uid the event is stored under.
 *
 * `userIdForKey`, the same call `captureProposalPath` makes, so the answer
 * lands in the same tree as the proposal it is about even for the scope ids
 * that predate Firebase auth.
 */
export function clarificationEventCollection(scopeId: string): string {
  return userCol(userIdForKey(scopeId), CLARIFICATION_EVENTS);
}

export async function appendClarificationEvent(
  scopeId: string,
  event: ClarificationAnsweredEvent,
): Promise<void> {
  const record: ClarificationAnsweredRecord = {
    type: 'clarification_answered',
    uid: userIdForKey(scopeId),
    proposalId: event.proposalId,
    itemId: event.itemId,
    field: event.field,
    answerKind: event.answerKind,
    at: event.at,
  };
  await getStorage().set(
    `${clarificationEventCollection(scopeId)}/${clarificationDocId(record)}`,
    record as unknown as Record<string, unknown>,
  );
}

/** Everything this account answered, oldest first. */
export async function listClarificationEvents(
  scopeId: string,
): Promise<ClarificationAnsweredRecord[]> {
  const rows = await getStorage().list<ClarificationAnsweredRecord>(
    clarificationEventCollection(scopeId),
  );
  return rows
    .map((row) => row.data)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}
