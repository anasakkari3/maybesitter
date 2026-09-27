/**
 * Where a goal planner model's answer is kept for one generation (CL3).
 *
 * The graph is rebuilt on every read, which was safe while its only inputs
 * were the goal's sentence and a deterministic engine: `generate` and the
 * rebuild inside `confirm` produced the same nodes. A model does not answer
 * the same way twice, so without this a user would review six steps, press
 * confirm, and have their selection resolved against six different ones —
 * every one refused as `unknown_node`.
 *
 * So the one thing a rebuild cannot reproduce is stored: the validated step
 * list, keyed by goal and generation, written once. A second `generate` at the
 * same generation reads it back instead of paying for another call, and
 * `confirm` and the execution read resolve against it.
 *
 * The goal's text is keyed in as a hash. An edited goal is a different goal,
 * and steps planned for the old wording must not come back under the new one.
 *
 * Writes only this collection. It has no import path to a Commitment, a Habit
 * or a plan, and `tests/goalGraph/goalGraphBoundaries.test.ts` holds it to that.
 */
import {
  GOAL_GRAPH_PROPOSALS,
  docIdForKey,
  getStorage,
  requireUserId,
  userCol,
  userSubDoc,
  type StorageAdapter,
} from '../storage';
import type { GoalStepDraft } from './goalStepPlan';

export const GOAL_STEP_PROPOSAL_SCHEMA_VERSION = 1 as const;

export interface StoredGoalStepProposal {
  readonly schemaVersion: typeof GOAL_STEP_PROPOSAL_SCHEMA_VERSION;
  readonly goalMemoryId: string;
  readonly generation: number;
  /** `docIdForKey` of the goal's text when the steps were planned. */
  readonly goalTextKey: string;
  readonly steps: readonly GoalStepDraft[];
  readonly promptVersion: string;
  /** The model that answered, as the provider reported it. */
  readonly model: string | null;
  readonly createdAt: string;
}

export interface GoalStepProposalStore {
  /** The steps planned for this goal text at this generation, or null. */
  get(scopeId: string, goalMemoryId: string, generation: number, goalText: string): Promise<StoredGoalStepProposal | null>;
  /**
   * Keeps `proposal` unless one is already there, and returns whichever is
   * kept — so two concurrent `generate`s agree on one answer.
   */
  putIfAbsent(scopeId: string, proposal: StoredGoalStepProposal): Promise<StoredGoalStepProposal>;
  /**
   * Removes every stored reading of these goals, at every generation. The
   * memory delete and edit paths call it: a proposal is a model's paraphrase
   * of the goal, and it must not outlive the goal it paraphrases.
   */
  deleteForGoals(scopeId: string, goalMemoryIds: readonly string[]): Promise<number>;
}

export function goalTextKeyFor(goalText: string): string {
  return docIdForKey(`goal-text:${goalText}`);
}

function proposalPath(scopeId: string, goalMemoryId: string, generation: number): string {
  return userSubDoc(
    requireUserId(scopeId),
    GOAL_GRAPH_PROPOSALS,
    docIdForKey(`goal-step-proposal:${goalMemoryId}:${generation}`),
  );
}

class StorageGoalStepProposalStore implements GoalStepProposalStore {
  constructor(private readonly injected?: StorageAdapter) {}

  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  async get(
    scopeId: string,
    goalMemoryId: string,
    generation: number,
    goalText: string,
  ): Promise<StoredGoalStepProposal | null> {
    const stored = await this.storage.get<StoredGoalStepProposal>(proposalPath(scopeId, goalMemoryId, generation));
    if (!stored || stored.schemaVersion !== GOAL_STEP_PROPOSAL_SCHEMA_VERSION) return null;
    if (stored.goalTextKey !== goalTextKeyFor(goalText)) return null;
    return stored;
  }

  async putIfAbsent(scopeId: string, proposal: StoredGoalStepProposal): Promise<StoredGoalStepProposal> {
    const path = proposalPath(scopeId, proposal.goalMemoryId, proposal.generation);
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<StoredGoalStepProposal>(path);
      if (existing && existing.schemaVersion === GOAL_STEP_PROPOSAL_SCHEMA_VERSION
        && existing.goalTextKey === proposal.goalTextKey) {
        return existing;
      }
      tx.set<StoredGoalStepProposal>(path, proposal);
      return proposal;
    });
  }

  async deleteForGoals(scopeId: string, goalMemoryIds: readonly string[]): Promise<number> {
    if (goalMemoryIds.length === 0) return 0;
    const wanted = new Set(goalMemoryIds);
    const collection = userCol(requireUserId(scopeId), GOAL_GRAPH_PROPOSALS);
    let removed = 0;
    for (const row of await this.storage.list<StoredGoalStepProposal>(collection)) {
      // By the field, not by recomputing ids: every generation of the goal
      // goes, including ones this process never saw written.
      if (!wanted.has(row.data.goalMemoryId)) continue;
      await this.storage.delete(`${collection}/${row.id}`);
      removed += 1;
    }
    return removed;
  }
}

export function createStorageGoalStepProposalStore(adapter?: StorageAdapter): GoalStepProposalStore {
  return new StorageGoalStepProposalStore(adapter);
}
