/**
 * The judgements the durability check makes, separated from the I/O that
 * gathers the evidence (UC-1.9, #153).
 *
 * These are pure so they can be unit-tested with synthetic responses: a
 * durability run against staging costs money and minutes, and "did the script
 * interpret the results correctly" must not be one of the unknowns when it
 * fails at 3am.
 */

/** How many distinct instances served a set of responses. */
export function countDistinctInstances(instanceIds: readonly (string | null | undefined)[]): number {
  return new Set(instanceIds.filter((id): id is string => typeof id === 'string' && id.length > 0)).size;
}

export interface IdempotentResponse {
  status: number;
  /** The server's own claim that it returned a previously recorded decision. */
  replayed?: boolean;
}

export interface IdempotencyTally {
  accepted: number;
  replayed: number;
  conflicts: number;
  failed: number;
  /** One decision recorded, every other caller told so. */
  ok: boolean;
}

/**
 * N concurrent calls with the same idempotency key must record exactly one
 * decision. Everyone else must be told they replayed it, or lose the race with
 * a 409 — never a second write, and never a 5xx.
 */
export function tallyIdempotency(responses: readonly IdempotentResponse[]): IdempotencyTally {
  let accepted = 0;
  let replayed = 0;
  let conflicts = 0;
  let failed = 0;

  for (const response of responses) {
    if (response.status === 409) conflicts += 1;
    else if (response.status >= 400) failed += 1;
    else if (response.replayed === true) replayed += 1;
    else accepted += 1;
  }

  return {
    accepted,
    replayed,
    conflicts,
    failed,
    ok: accepted === 1 && failed === 0 && accepted + replayed + conflicts === responses.length,
  };
}

export type CommitmentActionKind = 'complete' | 'postpone' | 'cancel';

export interface AppliedAction {
  kind: CommitmentActionKind;
  /** The server accepted it; a rejected action must not move the state. */
  accepted: boolean;
  /** Server-assigned ordering, not client send order. */
  at: string;
}

export interface FinalState {
  status: 'completed' | 'postponed' | 'cancelled' | 'unchanged';
  acceptedCount: number;
}

/**
 * Mixed complete/postpone/cancel calls race each other. The commitment must end
 * in the state of the last action the server accepted, and its event count must
 * equal the number of accepted actions — no lost write, no double apply.
 */
export function finalStateFrom(actions: readonly AppliedAction[]): FinalState {
  const accepted = actions
    .filter((action) => action.accepted)
    .slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const last = accepted[accepted.length - 1];
  if (!last) return { status: 'unchanged', acceptedCount: 0 };

  const status =
    last.kind === 'complete' ? 'completed' : last.kind === 'postpone' ? 'postponed' : 'cancelled';
  return { status, acceptedCount: accepted.length };
}

/**
 * The states the commitment may legitimately be in after concurrent actions.
 *
 * `finalStateFrom` answers "the last accepted action wins", which needs the
 * last action to be identifiable. Ten actions racing on one commitment can be
 * stamped with the *same* `updatedAt` to the millisecond — that is what the
 * first staging run showed — and then several of them are equally last. Any of
 * those is a correct outcome; what would be wrong is a state no accepted
 * action could produce, or a change with nothing accepted at all.
 */
export function possibleFinalStatuses(actions: readonly AppliedAction[]): FinalState['status'][] {
  const accepted = actions.filter((action) => action.accepted);
  if (accepted.length === 0) return ['unchanged'];
  const latest = Math.max(...accepted.map((action) => Date.parse(action.at)));
  const tied = accepted.filter((action) => Date.parse(action.at) === latest);
  const byKind = { complete: 'completed', postpone: 'postponed', cancel: 'cancelled' } as const;
  return Array.from(new Set(tied.map((action) => byKind[action.kind])));
}

export interface Timestamped {
  updatedAt: string;
}

/** The value the server settled on: the one it stamped last. */
export function latestByUpdatedAt<T extends Timestamped>(items: readonly T[]): T | null {
  let latest: T | null = null;
  for (const item of items) {
    if (!latest || Date.parse(item.updatedAt) > Date.parse(latest.updatedAt)) latest = item;
  }
  return latest;
}

export interface RevisionPair {
  before: string | null;
  after: string | null;
}

/** A redeploy must actually produce a new revision, or phase 4 proves nothing. */
export function revisionChanged(revisions: RevisionPair): boolean {
  return Boolean(revisions.before) && Boolean(revisions.after) && revisions.before !== revisions.after;
}

export type CheckResult = 'pass' | 'fail';

export interface DurabilitySummary {
  runId: string;
  revisions: RevisionPair;
  instances: number;
  counts: Record<string, number>;
  checks: Record<string, CheckResult>;
  durationMs: number;
}

/** Non-zero exit if any check failed. */
export function summaryExitCode(summary: Pick<DurabilitySummary, 'checks'>): 0 | 1 {
  return Object.values(summary.checks).some((result) => result === 'fail') ? 1 : 0;
}

/**
 * The domain's own status words, in the vocabulary `finalStateFrom` answers in.
 *
 * They are not the same words: a postponed commitment is `deferred` and a
 * cancelled one is `dropped`. Comparing the two vocabularies directly is the
 * kind of mistake that makes a durability run pass while the state is wrong.
 */
export function finalStatusFromCommitmentStatus(status: string): FinalState['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'deferred') return 'postponed';
  if (status === 'dropped') return 'cancelled';
  return 'unchanged';
}

export interface JobOutcome {
  status: string;
  attempts: number;
}

/**
 * A scheduled job must have run once and settled.
 *
 * This is about execution, not about the command succeeding: a job whose
 * command is rejected is still a job that ran exactly once, and `failed` with
 * one attempt is the correct outcome for it. What must never happen is two
 * attempts (the same job ran twice) or a job still sitting claimed.
 */
export function jobRanExactlyOnce(job: JobOutcome | null | undefined): boolean {
  if (!job) return false;
  return job.attempts === 1 && (job.status === 'completed' || job.status === 'failed');
}
