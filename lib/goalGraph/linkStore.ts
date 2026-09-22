/**
 * Where a confirmed goal node's decision lives (#526, slice 2).
 *
 * ── The id is derived, which is what makes "Confirm" safe to press twice ──
 *
 * `linkId` is `docIdForKey(goalMemoryId:nodeId)`, so two confirmations of one
 * node address the *same document*, and `claim` is a transaction that reads
 * before it writes: the second one finds the first link and hands it back with
 * `replayed: true`. There is no window in which two links exist, because there
 * was never a second path to write to. Exactly the mechanism
 * `intentSeedStore` uses for a double-tapped "Keep", and here it is load
 * bearing for the same reason it is there — a duplicate is not a wasted row,
 * it is a second gym session in somebody's week.
 *
 * ── Two phases, because creation is not atomic with the claim ───
 *
 * A Commitment is written by `applyParticipantCommands` and a Habit by the
 * habit store; neither can join the transaction that claims the link. So
 * `claim` writes the link `pending` with no `entityId`, the caller creates the
 * entity, and `settle` records the id. A caller whose creation throws calls
 * `release`, which removes the claim so the user can press the button again —
 * the same recovery `promoteSeed` performs, and for the same reason: a node
 * stuck `pending` with nothing behind it is a dead end nobody can clear from
 * the screen.
 *
 * ── Unlinking removes the link and nothing else ─────────────────
 *
 * `remove` deletes one document in this collection. It cannot reach a
 * Commitment or a Habit — it does not import either — and that is how #526's
 * "deleting/unlinking a node does not delete canonical work" is held: not as a
 * rule somebody remembers, but as a module with no way to do the other thing.
 */
import {
  GOAL_GRAPH_LINK_SCHEMA_VERSION,
  type GoalLinkEntityKind,
  type GoalNodeLink,
} from '../../src/contracts/v1/goalGraphContracts';
import {
  GOAL_GRAPH_LINKS,
  docIdForKey,
  getStorage,
  requireUserId,
  userCol,
  userSubDoc,
  type StorageAdapter,
} from '../storage';

/** The document, which is the link exactly. Nothing is stored beside it. */
type StoredLink = GoalNodeLink;

export function goalNodeLinkIdFor(goalMemoryId: string, nodeId: string): string {
  return docIdForKey(`goal-node-link:${goalMemoryId}:${nodeId}`);
}

function linkPath(scopeId: string, linkId: string): string {
  return userSubDoc(requireUserId(scopeId), GOAL_GRAPH_LINKS, linkId);
}

export interface ClaimGoalNodeLinkInput {
  readonly scopeId: string;
  readonly goalMemoryId: string;
  readonly nodeId: string;
  readonly entityKind: GoalLinkEntityKind;
  /** The instant the user pressed confirm, passed in rather than read here. */
  readonly confirmedByUserAt: string;
}

export interface GoalNodeLinkStore {
  /**
   * Reserves the link, or hands back the one this node already has.
   * `replayed` distinguishes the two so the caller creates nothing the second
   * time — which is the whole of the idempotency guarantee.
   */
  claim(input: ClaimGoalNodeLinkInput, now: string): Promise<{ link: GoalNodeLink; replayed: boolean }>;
  /** Records the id the creation produced. Null when the claim is gone. */
  settle(scopeId: string, linkId: string, entityId: string, now: string): Promise<GoalNodeLink | null>;
  /** Drops a claim whose creation failed, so the user may try again. */
  release(scopeId: string, linkId: string): Promise<void>;
  list(scopeId: string, goalMemoryId: string): Promise<readonly GoalNodeLink[]>;
  get(scopeId: string, linkId: string): Promise<GoalNodeLink | null>;
  /** Unlinks. Removes this document and nothing else. See the header. */
  remove(scopeId: string, linkId: string): Promise<boolean>;
  deleteScope(scopeId: string): Promise<number>;
}

/**
 * Ascending by node id, decided here rather than left to the adapter.
 *
 * The two adapters disagree about the natural order of a collection read, and
 * the node id is the one key that is stable across generations of the same
 * graph — ordering by `createdAt` would reshuffle two links confirmed in the
 * same millisecond on every read.
 */
function byNodeId(a: GoalNodeLink, b: GoalNodeLink): number {
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

export class StorageGoalNodeLinkStore implements GoalNodeLinkStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  async claim(
    input: ClaimGoalNodeLinkInput,
    now: string,
  ): Promise<{ link: GoalNodeLink; replayed: boolean }> {
    const linkId = goalNodeLinkIdFor(input.goalMemoryId, input.nodeId);
    const path = linkPath(input.scopeId, linkId);
    const link: GoalNodeLink = {
      schemaVersion: GOAL_GRAPH_LINK_SCHEMA_VERSION,
      linkId,
      scopeId: input.scopeId,
      goalMemoryId: input.goalMemoryId,
      nodeId: input.nodeId,
      entityKind: input.entityKind,
      // Null until the entity exists. A link that named an id before anything
      // was created would point at nothing, and progress would read it.
      entityId: null,
      state: 'pending',
      confirmedByUserAt: input.confirmedByUserAt,
      createdAt: now,
      updatedAt: now,
    };
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<StoredLink>(path);
      // The replay. Not an error and not a second row: the first link, with
      // the flag that tells the caller to create nothing.
      if (existing) return { link: existing, replayed: true };
      tx.create<StoredLink>(path, link);
      return { link, replayed: false };
    });
  }

  async settle(
    scopeId: string,
    linkId: string,
    entityId: string,
    now: string,
  ): Promise<GoalNodeLink | null> {
    const path = linkPath(scopeId, linkId);
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<StoredLink>(path);
      if (!existing) return null;
      const settled: GoalNodeLink = { ...existing, entityId, state: 'linked', updatedAt: now };
      tx.set<StoredLink>(path, settled);
      return settled;
    });
  }

  async release(scopeId: string, linkId: string): Promise<void> {
    await this.storage.delete(linkPath(scopeId, linkId));
  }

  async list(scopeId: string, goalMemoryId: string): Promise<readonly GoalNodeLink[]> {
    const rows = await this.storage.list<StoredLink>(userCol(requireUserId(scopeId), GOAL_GRAPH_LINKS));
    return rows
      .map((row) => row.data)
      .filter((link) => link.goalMemoryId === goalMemoryId)
      .sort(byNodeId);
  }

  async get(scopeId: string, linkId: string): Promise<GoalNodeLink | null> {
    return (await this.storage.get<StoredLink>(linkPath(scopeId, linkId))) ?? null;
  }

  async remove(scopeId: string, linkId: string): Promise<boolean> {
    const path = linkPath(scopeId, linkId);
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<StoredLink>(path);
      if (!existing) return false;
      // One delete, of one document in this collection. The Commitment or
      // Habit this named is untouched and stays in the user's week.
      tx.delete(path);
      return true;
    });
  }

  async deleteScope(scopeId: string): Promise<number> {
    const collection = userCol(requireUserId(scopeId), GOAL_GRAPH_LINKS);
    const rows = await this.storage.list<StoredLink>(collection);
    for (const row of rows) await this.storage.delete(`${collection}/${row.id}`);
    return rows.length;
  }
}

export function createStorageGoalNodeLinkStore(adapter?: StorageAdapter): GoalNodeLinkStore {
  return new StorageGoalNodeLinkStore(adapter);
}
