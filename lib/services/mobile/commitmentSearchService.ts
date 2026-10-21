import type { Commitment } from '../../../src/domain/stateMachine';
import { foldForSearch, isWordPrefixMatch } from '../../../src/text/foldForSearch';
import { getParticipantStateSnapshot } from './participantState';
import { resolvedCommitmentTime } from './time';

const SETTLED_WINDOW_MS = 90 * 24 * 60 * 60_000;
const LIVE_STATUSES = new Set<Commitment['status']>(['active', 'deferred', 'missed']);

export interface CommitmentSearchOptions {
  participantId: string;
  foldedQuery: string;
  now?: Date;
}

interface SearchMatch {
  commitment: Commitment;
  tier: 0 | 1;
  live: boolean;
  time: number;
}

function finiteInstant(value: string | null | undefined, fallback: string): number {
  const parsed = Date.parse(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : 0;
}

function eligibleSettlement(commitment: Commitment, cutoff: number): string | null {
  if (commitment.status === 'completed' && commitment.completedAt) return commitment.completedAt;
  if (commitment.status === 'dropped' && commitment.droppedAt) return commitment.droppedAt;
  return null;
}

/** Account-scoped search candidates, fully ranked but not yet limited. */
export async function searchCommitments(options: CommitmentSearchOptions): Promise<Commitment[]> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const cutoff = nowMs - SETTLED_WINDOW_MS;
  const state = await getParticipantStateSnapshot(options.participantId);
  const matches: SearchMatch[] = [];

  for (const commitment of Object.values(state.commitments)) {
    const live = LIVE_STATUSES.has(commitment.status);
    const settledAt = live ? null : eligibleSettlement(commitment, cutoff);
    if (!live && (!settledAt || finiteInstant(settledAt, commitment.updatedAt) < cutoff)) continue;

    const searchable = foldForSearch(`${commitment.title}\n${commitment.description ?? ''}`);
    if (!searchable.includes(options.foldedQuery)) continue;
    const resolved = live
      ? finiteInstant(resolvedCommitmentTime(commitment), commitment.createdAt)
      : finiteInstant(settledAt, commitment.updatedAt);
    matches.push({
      commitment,
      tier: isWordPrefixMatch(searchable, options.foldedQuery) ? 0 : 1,
      live,
      time: resolved,
    });
  }

  matches.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.live !== b.live) return a.live ? -1 : 1;
    if (a.time !== b.time) {
      return a.live
        ? Math.abs(a.time - nowMs) - Math.abs(b.time - nowMs)
        : b.time - a.time;
    }
    return a.commitment.id.localeCompare(b.commitment.id);
  });
  return matches.map(({ commitment }) => commitment);
}
