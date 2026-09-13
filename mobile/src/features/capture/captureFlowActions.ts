/**
 * What the capture flow *does*, separated from the React that hosts it
 * (UC-2.R2, #172).
 *
 * `captureMachine.ts` answers "which state does this event lead to". This
 * answers "which requests are made, in what order, and what is reported when
 * one of them fails" — and it takes those requests as arguments rather than
 * importing them, so the answers are checkable without a renderer, a query
 * client or a fetch mock.
 *
 * That matters for exactly one reason: the acceptance criteria here are about
 * requests. "Nothing exists until Confirm" is a claim about which calls happen
 * before a confirm, and "never claim a full undo" is a claim about what is
 * reported when one delete of three fails. Both are arithmetic once the calls
 * are parameters.
 */
import {
  confirmPayload,
  type CaptureFailureKind,
  type CaptureItemEdit,
  type CaptureState,
} from './captureMachine';
import type { UserFacingKey } from '../../api/ui/userFacingMessage';
import type { CaptureConfirmation, CaptureProposal } from '../../api/schemas/capture';

/** The calls the flow is allowed to make. Nothing else reaches the network. */
export interface CaptureGateway {
  propose(text: string): Promise<CaptureProposal>;
  confirm(input: {
    proposalId: string;
    itemIds: string[];
    edits: Record<string, CaptureItemEdit>;
  }): Promise<CaptureConfirmation>;
  /** Soft delete. Used only by undo, only for ids the server said it saved. */
  remove(commitmentId: string): Promise<unknown>;
}

/**
 * What a failed analyze is: which recovery the screen offers, and which line
 * it shows.
 *
 * The two are separate answers. `kind` decides whether there is a Retry —
 * a refused input and a spent quota both mean "not by pressing that button" —
 * and `messageKey` is the words, which come from the product's one copy table
 * (`userFacingMessageKey`) rather than from a branch in a screen (#181).
 */
export interface AnalyzeFailure {
  kind: CaptureFailureKind;
  messageKey: UserFacingKey;
}

export type AnalyzeOutcome =
  | { ok: true; proposal: CaptureProposal }
  | ({ ok: false } & AnalyzeFailure);

export type ConfirmOutcome =
  | { ok: true; confirmation: CaptureConfirmation }
  | { ok: false; reason: string };

/** What Undo managed. A partial result is reported as partial. */
export interface UndoOutcome {
  undone: string[];
  stillSaved: string[];
}

export function analyzeCapture(
  gateway: Pick<CaptureGateway, 'propose'>,
  text: string,
  classify: (error: unknown) => AnalyzeFailure,
): Promise<AnalyzeOutcome> {
  return gateway
    .propose(text)
    .then((proposal): AnalyzeOutcome => ({ ok: true, proposal }))
    .catch((error): AnalyzeOutcome => ({ ok: false, ...classify(error) }));
}

/**
 * Confirms the selection, and only the selection.
 *
 * Returns `null` when there is nothing to confirm, so the caller does not have
 * to decide whether an empty confirm is a request worth making. It is not: the
 * server would refuse it, and the user would see an error for having deselected
 * everything.
 */
export async function confirmCapture(
  gateway: Pick<CaptureGateway, 'confirm'>,
  state: CaptureState,
): Promise<ConfirmOutcome | null> {
  const payload = confirmPayload(state);
  if (payload.itemIds.length === 0) return null;

  try {
    const confirmation = await gateway.confirm(payload);
    // A 200 whose body says `success: false` is a failure. Before #252 a confirm
    // that persisted nothing still answered 200, and no client could tell; the
    // route answers 404/400 now *and* the body still carries the truth, so both
    // are checked rather than one being trusted.
    if (!confirmation.success) {
      return { ok: false, reason: confirmation.failureCode ?? 'confirmation_failed' };
    }
    return { ok: true, confirmation };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : 'confirmation_failed' };
  }
}

/**
 * Undoes what was saved, one at a time, and reports honestly.
 *
 * Sequential rather than parallel: each delete is a mutation on its own
 * document, and a burst of them racing is how one gets lost.
 *
 * The ids come from the server's `persisted`, never from what the client
 * selected — undoing something the server never saved would delete whatever now
 * holds that id.
 *
 * A partial failure is reported as one. "Undone" while a commitment is still
 * there is the worst available outcome, worse than saying the undo half worked.
 */
export async function undoCapture(
  gateway: Pick<CaptureGateway, 'remove'>,
  persisted: CaptureConfirmation['persisted'],
): Promise<UndoOutcome> {
  const undone: string[] = [];
  const stillSaved: string[] = [];
  for (const item of persisted) {
    try {
      await gateway.remove(item.commitmentId);
      undone.push(item.commitmentId);
    } catch {
      stillSaved.push(item.commitmentId);
    }
  }
  return { undone, stillSaved };
}
