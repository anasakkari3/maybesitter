import type { CaptureProposalContract, CaptureRemovedItemContract } from '../../../src/contracts/v1/captureContracts';
import type { StoredCaptureProposal } from '../captureBoundary/proposalStore';

export interface ChatReferenceState {
  refs: Record<string, string>;
  nextItem: number;
  nextSeed: number;
}

export function referenceStateForContract(
  contract: Pick<CaptureProposalContract, 'items' | 'seeds'>,
  existing: Readonly<Record<string, string>> = {},
  storedNextItem = 1,
  storedNextSeed = 1,
): ChatReferenceState {
  const refs = { ...existing };
  let nextItem = Math.max(storedNextItem, nextAfter('i', Object.values(refs)));
  let nextSeed = Math.max(storedNextSeed, nextAfter('s', Object.values(refs)));
  for (const item of contract.items) if (!refs[item.itemId]) refs[item.itemId] = `i${nextItem++}`;
  for (const seed of contract.seeds) if (!refs[seed.seedItemId]) refs[seed.seedItemId] = `s${nextSeed++}`;
  return { refs, nextItem, nextSeed };
}

function nextAfter(prefix: 'i' | 's', values: readonly string[]): number {
  let next = 1;
  for (const value of values) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(value);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

/**
 * Reads persisted refs, assigning legacy proposals deterministically by index.
 * The caller persists the returned state on its next proposal save.
 */
export function referenceStateFor(stored: StoredCaptureProposal): ChatReferenceState {
  return referenceStateForContract(
    stored.contract,
    stored.chatRefs,
    stored.nextChatItemRef,
    stored.nextChatSeedRef,
  );
}

export function publicRemovedItems(stored: Pick<StoredCaptureProposal, 'removedChatEntities'>): CaptureRemovedItemContract[] | undefined {
  const removed = Object.values(stored.removedChatEntities ?? {})
    .sort((a, b) => a.position - b.position)
    .map((entry): CaptureRemovedItemContract => entry.item
      ? { itemId: entry.item.itemId, kind: 'commitment', text: entry.item.title }
      : { seedItemId: entry.seed!.seedItemId, kind: entry.seed!.kind, text: entry.seed!.summary });
  return removed.length > 0 ? removed : undefined;
}

export function withPublicRemovedItems(
  contract: CaptureProposalContract,
  stored: Pick<StoredCaptureProposal, 'removedChatEntities'>,
): CaptureProposalContract {
  const removedItems = publicRemovedItems(stored);
  const { removedItems: _old, ...rest } = contract;
  return removedItems ? { ...rest, removedItems } : rest;
}
