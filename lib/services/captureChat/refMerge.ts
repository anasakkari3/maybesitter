import type { CaptureProposalContract } from '../../../src/contracts/v1/captureContracts';
import type {
  CaptureProposalStore,
  RemovedChatEntity,
  StoredCaptureProposal,
} from '../captureBoundary/proposalStore';
import { finalizeUnderstood } from '../captureBoundary/understood';
import { referenceStateFor, withPublicRemovedItems } from './chatReferences';

export interface ChatRefOperation {
  ref: string;
  op: 'keep' | 'update' | 'remove';
  fields?: unknown;
}

export interface ChatRefMergePlan {
  locked: readonly ChatRefOperation[];
  open: readonly ChatRefOperation[];
  delta: readonly ({ kind: 'update'; ref: string } | { kind: 'added' })[];
}

function statusOf(contract: CaptureProposalContract): CaptureProposalContract['status'] {
  if (contract.items.length === 0) return contract.seeds.length > 0 ? 'unresolved_intent' : 'no_commitment';
  return contract.items.every((item) => item.needsClarification) ? 'needs_clarification' : 'proposed';
}

function orderedEntityIds(stored: StoredCaptureProposal): string[] {
  const all = new Set([
    ...stored.contract.items.map((item) => item.itemId),
    ...stored.contract.seeds.map((seed) => seed.seedItemId),
  ]);
  const ordered = stored.contract.understood?.flatMap((point) => {
    const id = point.kind === 'commitment' ? point.itemId : point.seedItemId;
    return all.delete(id) ? [id] : [];
  }) ?? [];
  return [...ordered, ...Array.from(all)];
}

function removeEntity(stored: StoredCaptureProposal, id: string): void {
  stored.contract.items = stored.contract.items.filter((item) => item.itemId !== id);
  stored.contract.seeds = stored.contract.seeds.filter((seed) => seed.seedItemId !== id);
  (stored.commandsByItemId as Map<string, readonly import('../../../src/domain/stateMachine').Command[]>).delete(id);
  (stored.resultsByItemId as Map<string, import('../../../src/extraction/extractionTypes').ExtractionResult> | undefined)?.delete(id);
  if (stored.sourceOrdinals) {
    delete stored.sourceOrdinals.items[id];
    delete stored.sourceOrdinals.seeds[id];
  }
  if (stored.chatOperationIndices) {
    delete stored.chatOperationIndices.items[id];
    delete stored.chatOperationIndices.seeds[id];
  }
  if (stored.correctionSpans) for (const [correctionId, span] of Object.entries(stored.correctionSpans)) {
    if (span.itemId === id) delete stored.correctionSpans[correctionId];
  }
}

function snapshotOf(stored: StoredCaptureProposal, id: string, ref: string, position: number): RemovedChatEntity | null {
  const item = stored.contract.items.find((candidate) => candidate.itemId === id);
  const seed = stored.contract.seeds.find((candidate) => candidate.seedItemId === id);
  if (!item && !seed) return null;
  const correctionSpans = Object.fromEntries(Object.entries(stored.correctionSpans ?? {}).filter(([, span]) => span.itemId === id));
  const ordinal = stored.sourceOrdinals?.items[id] ?? stored.sourceOrdinals?.seeds[id];
  return {
    ref,
    entityId: id,
    position,
    ...(item ? { item: { ...item } } : { seed: { ...seed! } }),
    commands: [...(stored.commandsByItemId.get(id) ?? [])],
    ...(stored.resultsByItemId?.get(id) ? { result: { ...stored.resultsByItemId.get(id)! } } : {}),
    ...(Number.isFinite(ordinal) ? { ordinal } : {}),
    ...(Object.keys(correctionSpans).length > 0 ? { correctionSpans } : {}),
    ...(stored.structuredEditSources?.[id] ? { structuredEditSource: stored.structuredEditSources[id] } : {}),
    ...(stored.keptSeedItemIds?.includes(id) ? { keptSeed: true as const } : {}),
  };
}

function mutableCopy(stored: StoredCaptureProposal): StoredCaptureProposal {
  return {
    ...stored,
    contract: {
      ...stored.contract,
      items: stored.contract.items.map((item) => ({ ...item })),
      seeds: stored.contract.seeds.map((seed) => ({ ...seed })),
    },
    commandsByItemId: new Map(stored.commandsByItemId),
    resultsByItemId: new Map(stored.resultsByItemId ?? []),
    sourceOrdinals: {
      items: { ...(stored.sourceOrdinals?.items ?? {}) },
      seeds: { ...(stored.sourceOrdinals?.seeds ?? {}) },
    },
    chatOperationIndices: {
      items: { ...(stored.chatOperationIndices?.items ?? {}) },
      seeds: { ...(stored.chatOperationIndices?.seeds ?? {}) },
    },
    correctionSpans: { ...(stored.correctionSpans ?? {}) },
    structuredEditSources: { ...(stored.structuredEditSources ?? {}) },
    removedChatEntities: { ...(stored.removedChatEntities ?? {}) },
  };
}

/** Server-authoritative carry. Existing identity is resolved only by opaque ref. */
export async function mergeChatProposalByRef(
  store: CaptureProposalStore,
  baseProposalId: string | undefined,
  proposal: CaptureProposalContract,
  plan?: ChatRefMergePlan,
): Promise<CaptureProposalContract> {
  const built = await store.get(proposal.proposalId);
  if (!built) return proposal;
  if (!baseProposalId) {
    const state = referenceStateFor(built);
    const saved = { ...built, chatRefs: state.refs, nextChatItemRef: state.nextItem, nextChatSeedRef: state.nextSeed };
    saved.chatOperationIndices = undefined;
    saved.contract = withPublicRemovedItems(saved.contract, saved);
    await store.put(saved);
    return saved.contract;
  }

  const base = await store.get(baseProposalId);
  if (!base) return proposal;
  const refs = referenceStateFor(base);
  const byRef = new Map(Object.entries(refs.refs).map(([id, ref]) => [ref, id]));
  const locked = new Set(base.lockedChatRefs ?? []);
  const next = mutableCopy(base);
  next.contract = {
    ...next.contract,
    proposalId: built.contract.proposalId,
    provenance: built.contract.provenance,
    revision: 0,
  };
  next.scopeId = built.scopeId;
  next.proposedAt = built.proposedAt;
  next.responseLocale = built.responseLocale;
  next.timezone = built.timezone;
  next.editReceipt = undefined;
  next.legacyConfirmRevision = undefined;

  const order = orderedEntityIds(base);
  for (const operation of plan?.locked ?? []) {
    if (operation.op !== 'remove' || !locked.has(operation.ref)) continue;
    const id = byRef.get(operation.ref);
    if (!id) continue;
    const snapshot = snapshotOf(base, id, operation.ref, Math.max(0, order.indexOf(id)));
    if (!snapshot) continue;
    (next.removedChatEntities as Record<string, RemovedChatEntity>)[operation.ref] = snapshot;
    removeEntity(next, id);
  }
  for (const operation of plan?.open ?? []) {
    if (operation.op !== 'remove' || locked.has(operation.ref)) continue;
    const id = byRef.get(operation.ref);
    if (id) removeEntity(next, id);
  }

  type BuiltEntity = {
    id: string;
    item?: CaptureProposalContract['items'][number];
    seed?: CaptureProposalContract['seeds'][number];
    ordinal?: number;
  };
  const builtEntities = (index: number): BuiltEntity[] => [
    ...built.contract.items.map((item) => ({ id: item.itemId, item, ordinal: built.chatOperationIndices?.items[item.itemId] })),
    ...built.contract.seeds.map((seed) => ({ id: seed.seedItemId, seed, ordinal: built.chatOperationIndices?.seeds[seed.seedItemId] })),
  ].filter((entry) => Math.floor(entry.ordinal ?? -1) === index)
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));

  if (plan && plan.delta.some((_, index) => builtEntities(index).length === 0)) {
    return withPublicRemovedItems(base.contract, base);
  }

  // New points follow the complete prior list, including a locked point that
  // moved to removedItems. Reusing its ordinal would make an exact restore
  // come back after the new point instead of in its original place.
  let nextOrdinal = Math.max(
    -1,
    ...Object.values(base.sourceOrdinals?.items ?? {}),
    ...Object.values(base.sourceOrdinals?.seeds ?? {}),
  ) + 1;
  let nextItemRef = refs.nextItem;
  let nextSeedRef = refs.nextSeed;
  const chatRefs = { ...refs.refs };
  const touched = new Set<string>();

  const appendBuilt = (entry: BuiltEntity, existingId?: string) => {
    const id = existingId ?? entry.id;
    const ordinal = existingId
      ? (base.sourceOrdinals?.items[existingId] ?? base.sourceOrdinals?.seeds[existingId] ?? nextOrdinal++)
      : nextOrdinal++;
    if (existingId) removeEntity(next, existingId);
    if (entry.item) {
      next.contract.items.push({ ...entry.item, itemId: id });
      (next.commandsByItemId as Map<string, readonly import('../../../src/domain/stateMachine').Command[]>).set(id, [...(built.commandsByItemId.get(entry.id) ?? [])]);
      const result = built.resultsByItemId?.get(entry.id);
      if (result) (next.resultsByItemId as Map<string, import('../../../src/extraction/extractionTypes').ExtractionResult>).set(id, result);
      next.sourceOrdinals!.items[id] = ordinal;
      chatRefs[id] ??= `i${nextItemRef++}`;
    } else {
      next.contract.seeds.push({ ...entry.seed!, seedItemId: id });
      next.sourceOrdinals!.seeds[id] = ordinal;
      chatRefs[id] ??= `s${nextSeedRef++}`;
    }
    for (const [correctionId, span] of Object.entries(built.correctionSpans ?? {})) {
      if (span.itemId === entry.id) next.correctionSpans![correctionId] = { ...span, itemId: id };
    }
    touched.add(id);
  };

  if (plan) {
    plan.delta.forEach((descriptor, index) => {
      const entities = builtEntities(index);
      if (descriptor.kind === 'update') {
        const existingId = byRef.get(descriptor.ref);
        if (!existingId || locked.has(descriptor.ref)) return;
        appendBuilt(entities[0]!, existingId);
        for (const extra of entities.slice(1)) appendBuilt(extra);
      } else {
        for (const entry of entities) appendBuilt(entry);
      }
    });
  } else {
    for (const item of built.contract.items) appendBuilt({ id: item.itemId, item, ordinal: built.sourceOrdinals?.items[item.itemId] });
    for (const seed of built.contract.seeds) appendBuilt({ id: seed.seedItemId, seed, ordinal: built.sourceOrdinals?.seeds[seed.seedItemId] });
  }

  next.chatRefs = chatRefs;
  next.nextChatItemRef = nextItemRef;
  next.nextChatSeedRef = nextSeedRef;
  next.lockedChatRefs = Array.from(locked);
  next.latestChatTouchedIds = Array.from(touched);
  next.keptSeedItemIds = base.keptSeedItemIds ? [...base.keptSeedItemIds] : undefined;
  next.seedKeepReceipt = base.seedKeepReceipt;
  next.chatOperationIndices = undefined;
  next.contract.items.sort((a, b) =>
    (next.sourceOrdinals!.items[a.itemId] ?? Number.POSITIVE_INFINITY)
    - (next.sourceOrdinals!.items[b.itemId] ?? Number.POSITIVE_INFINITY));
  next.contract.seeds.sort((a, b) =>
    (next.sourceOrdinals!.seeds[a.seedItemId] ?? Number.POSITIVE_INFINITY)
    - (next.sourceOrdinals!.seeds[b.seedItemId] ?? Number.POSITIVE_INFINITY));
  next.contract = finalizeUnderstood(
    withPublicRemovedItems({ ...next.contract, status: statusOf(next.contract) }, next),
    next.responseLocale ?? 'ar',
    next.sourceOrdinals!,
  );
  await store.put(next);
  return next.contract;
}
