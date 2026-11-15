/**
 * A watcher's «اقترح التزام» proposal, shown and decided in the app (QA audit
 * de7fcb8, CA6.1; owner decision 2026-11-15).
 *
 * A `propose_commitment` firing writes `watcherProposals/wpr_*` and nothing
 * canonical. This is the only code that turns one into anything, and only on
 * the person's explicit answer:
 *
 *   - **accept** runs the deterministic `CreateDraft` + `ConfirmCommitment`
 *     commands — the same pair an accepted proactive suggestion uses — through
 *     `commitCommandsWithClaim`, so the commitment and `state: 'accepted'` are
 *     one transaction. The title is the person's own words from the card.
 *   - **dismiss** marks it `dismissed` and writes nothing else.
 *
 * Decided once. The claim is re-read inside the transaction and anything but
 * `proposed` is a replay: a second tap, or two phones at once, makes no second
 * commitment and cannot flip the answer. The commitment id is derived from the
 * proposal id, so even a retried transaction names the same commitment.
 *
 * Lives outside `lib/watchers` on purpose: no watcher module may reach a
 * commitment writer (`tests/watchers/watcherSafety.test.ts`). The scope is
 * always the authenticated uid; a proposal id from another account is simply
 * not found.
 */
import type { Command } from '../../../src/domain/stateMachine';
import type { WatcherProposal } from '../../../src/contracts/v1/watcherContracts';
import { getStorage, requireUserId, userCol, userSubDoc, WATCHER_PROPOSALS, type StorageAdapter } from '../../storage';
import { commitCommandsWithClaim } from './participantState';

export const MAX_OPEN_WATCHER_PROPOSALS = 20;
export const MIN_PROPOSAL_TITLE = 1;
export const MAX_PROPOSAL_TITLE = 200;

const PROPOSAL_ID = /^wpr_[0-9a-f]{64}$/;

export class WatcherProposalRequestError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'WatcherProposalRequestError';
  }
}

/** What the app is shown: identifiers and the kind of watch, never content. */
export interface WatcherProposalDto {
  readonly proposalId: string;
  readonly signalKind: string;
  readonly proposedAt: string;
  readonly state: WatcherProposal['state'];
  readonly commitmentId: string | null;
}

export function presentWatcherProposal(proposal: WatcherProposal): WatcherProposalDto {
  return {
    proposalId: proposal.proposalId,
    signalKind: proposal.signalKind,
    proposedAt: proposal.proposedAt,
    state: proposal.state,
    commitmentId: proposal.commitmentId ?? null,
  };
}

export function parseWatcherProposalId(raw: string): string {
  if (!PROPOSAL_ID.test(raw)) throw new WatcherProposalRequestError('invalid_proposal_id');
  return raw;
}

export type WatcherProposalDecision =
  | { readonly decision: 'accept'; readonly title: string }
  | { readonly decision: 'dismiss' };

/** Rejects rather than coerces: an unknown field, a missing title, a wrong decision. */
export function parseWatcherProposalDecision(body: unknown): WatcherProposalDecision {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WatcherProposalRequestError('invalid_body');
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'decision' && key !== 'title')) {
    throw new WatcherProposalRequestError('unknown_field');
  }
  if (raw.decision === 'dismiss') {
    if (raw.title !== undefined) throw new WatcherProposalRequestError('unknown_field');
    return { decision: 'dismiss' };
  }
  if (raw.decision !== 'accept') throw new WatcherProposalRequestError('invalid_decision');
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (title.length < MIN_PROPOSAL_TITLE || title.length > MAX_PROPOSAL_TITLE) {
    throw new WatcherProposalRequestError('invalid_title');
  }
  return { decision: 'accept', title };
}

export async function listOpenWatcherProposals(
  uid: string,
  storage: StorageAdapter = getStorage(),
): Promise<WatcherProposalDto[]> {
  requireUserId(uid);
  const rows = await storage.list<WatcherProposal>(userCol(uid, WATCHER_PROPOSALS), {
    where: [['state', '==', 'proposed']],
  });
  return rows
    .map((row) => row.data)
    .sort((left, right) => right.proposedAt.localeCompare(left.proposedAt))
    .slice(0, MAX_OPEN_WATCHER_PROPOSALS)
    .map(presentWatcherProposal);
}

/** `wpr_<64 hex>` → `wpc_<40 hex>`: one proposal, one commitment, every retry. */
export function commitmentIdForProposal(proposalId: string): string {
  return `wpc_${proposalId.slice(4, 44)}`;
}

/** The proposal as it stands after the answer, or null when there is none. */
export async function decideWatcherProposal(
  uid: string,
  proposalId: string,
  decision: WatcherProposalDecision,
  now: string,
): Promise<WatcherProposal | null> {
  requireUserId(uid);
  const path = userSubDoc(uid, WATCHER_PROPOSALS, proposalId);
  const storage = getStorage();

  if (decision.decision === 'dismiss') {
    return storage.runTransaction(async (tx) => {
      const current = await tx.get<WatcherProposal>(path);
      if (!current) return null;
      if (current.state !== 'proposed') return current;
      const next: WatcherProposal = { ...current, state: 'dismissed', decidedAt: now };
      tx.set(path, next);
      return next;
    });
  }

  const commitmentId = commitmentIdForProposal(proposalId);
  const result = await commitCommandsWithClaim<WatcherProposal, 'missing'>(uid, path, (claim) => {
    if (!claim) return { outcome: 'missing' as const };
    if (claim.state !== 'proposed') return null;
    const commands: Command[] = [
      { type: 'CreateDraft', now, commitment: {
        id: commitmentId, kind: 'task', title: decision.title,
        priority: { level: 'normal', source: 'user_explicit', pressureAllowed: false },
      }, draftStatus: 'pending_confirmation' },
      { type: 'ConfirmCommitment', commitmentId, now },
    ];
    return { commands, patch: { state: 'accepted', decidedAt: now, commitmentId } };
  });
  if (result.outcome === 'missing') return null;
  return storage.get<WatcherProposal>(path);
}
