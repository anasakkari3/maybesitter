import type {
  CommunicativeIntent,
  RealizationPath,
  ResponseStrategy,
  RhetoricalMove,
} from './assistantTurn';

export type DiversityMemory = {
  pathCounts: Partial<Record<RealizationPath, number>>;
  moveCounts: Partial<Record<RhetoricalMove, number>>;
  lastPathsByIntent: Partial<Record<CommunicativeIntent, RealizationPath>>;
  recentPaths: RealizationPath[];
};

export type ConversationLevelState = DiversityMemory & {
  recentInteractionCount: number;
  recentClarificationCount: number;
  recentNoResponseCount: number;
  recentCompletionCount: number;
  recentDeferralCount: number;
  responsiveness: 'unknown' | 'responsive' | 'slow' | 'unresponsive';
  fatigue: 'low' | 'medium' | 'high';
};

export type CommitmentConversationState = {
  lastStrategy?: ResponseStrategy;
  lastPath?: RealizationPath;
  pressureState: 'idle' | 'eligible' | 'nudged' | 'small_step_offered' | 'blocker_probe_pending' | 'reset_offered' | 'decision_required' | 'recovered' | 'cooldown' | 'closed';
  pressureCount: number;
  ignoredCount: number;
  lastUserAction?: 'completed' | 'postponed' | 'ignored' | 'confirmed' | 'clarified';
};

export type ConversationStateStore = {
  get(scopeId: string): ConversationLevelState;
  getCommitment(scopeId: string, commitmentId: string): CommitmentConversationState;
  recordTurn(scopeId: string, turn: {
    eventType: string;
    intent: CommunicativeIntent;
    strategy: ResponseStrategy;
    path: RealizationPath;
    move?: RhetoricalMove;
    commitmentId?: string;
  }): void;
  clear(scopeId?: string): void;
};

function emptyConversationState(): ConversationLevelState {
  return {
    pathCounts: {},
    moveCounts: {},
    lastPathsByIntent: {},
    recentPaths: [],
    recentInteractionCount: 0,
    recentClarificationCount: 0,
    recentNoResponseCount: 0,
    recentCompletionCount: 0,
    recentDeferralCount: 0,
    responsiveness: 'unknown',
    fatigue: 'low',
  };
}

function emptyCommitmentState(): CommitmentConversationState {
  return {
    pressureState: 'idle',
    pressureCount: 0,
    ignoredCount: 0,
  };
}

function nextPressureState(strategy: ResponseStrategy): CommitmentConversationState['pressureState'] {
  if (strategy === 'easy_choice') return 'nudged';
  if (strategy === 'smaller_step') return 'small_step_offered';
  if (strategy === 'blocker_probe') return 'blocker_probe_pending';
  if (strategy === 'reset_plan') return 'reset_offered';
  if (strategy === 'close_loop') return 'decision_required';
  return 'idle';
}

export class MemoryConversationStateStore implements ConversationStateStore {
  private readonly conversations = new Map<string, ConversationLevelState>();
  private readonly commitments = new Map<string, Map<string, CommitmentConversationState>>();

  get(scopeId: string): ConversationLevelState {
    const existing = this.conversations.get(scopeId);
    if (existing) return existing;
    const created = emptyConversationState();
    this.conversations.set(scopeId, created);
    return created;
  }

  getCommitment(scopeId: string, commitmentId: string): CommitmentConversationState {
    const scoped = this.commitments.get(scopeId) || new Map<string, CommitmentConversationState>();
    const existing = scoped.get(commitmentId);
    if (existing) return existing;
    const created = emptyCommitmentState();
    scoped.set(commitmentId, created);
    this.commitments.set(scopeId, scoped);
    return created;
  }

  recordTurn(scopeId: string, turn: {
    eventType: string;
    intent: CommunicativeIntent;
    strategy: ResponseStrategy;
    path: RealizationPath;
    move?: RhetoricalMove;
    commitmentId?: string;
  }): void {
    const conversation = this.get(scopeId);
    conversation.recentInteractionCount += 1;
    conversation.pathCounts[turn.path] = (conversation.pathCounts[turn.path] || 0) + 1;
    conversation.lastPathsByIntent[turn.intent] = turn.path;
    conversation.recentPaths = [...conversation.recentPaths, turn.path].slice(-18);
    if (turn.move) conversation.moveCounts[turn.move] = (conversation.moveCounts[turn.move] || 0) + 1;
    if (turn.eventType === 'needs_clarification') conversation.recentClarificationCount += 1;
    if (turn.eventType === 'commitment_completed') conversation.recentCompletionCount += 1;
    if (turn.strategy === 'reset_plan' || turn.strategy === 'smaller_step') conversation.recentDeferralCount += 1;
    conversation.fatigue = conversation.recentInteractionCount >= 12 || conversation.recentClarificationCount >= 4 ? 'high' :
      conversation.recentInteractionCount >= 7 || conversation.recentClarificationCount >= 2 ? 'medium' :
        'low';

    if (!turn.commitmentId) return;
    const commitment = this.getCommitment(scopeId, turn.commitmentId);
    commitment.lastStrategy = turn.strategy;
    commitment.lastPath = turn.path;
    if (turn.intent === 'nudge' || turn.intent === 'probe_blocker' || turn.intent === 'reset_plan' || turn.intent === 'escalate_choice') {
      commitment.pressureCount += 1;
      commitment.pressureState = nextPressureState(turn.strategy);
    }
    if (turn.eventType === 'commitment_completed') {
      commitment.lastUserAction = 'completed';
      commitment.pressureState = 'closed';
    }
  }

  clear(scopeId?: string): void {
    if (scopeId) {
      this.conversations.delete(scopeId);
      this.commitments.delete(scopeId);
      return;
    }
    this.conversations.clear();
    this.commitments.clear();
  }
}

const defaultStore = new MemoryConversationStateStore();

export function getConversationStateStore(): ConversationStateStore {
  return defaultStore;
}
