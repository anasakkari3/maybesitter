/**
 * Deletion, and the receipt that proves it happened.
 *
 * ── Why a receipt at all ─────────────────────────────────────────
 *
 * #42's acceptance criterion is that **deletion is verifiable**, and a boolean
 * `{ deleted: true }` from the module that did the deleting verifies nothing —
 * it is the same actor asserting its own success. Every field below is instead
 * something the caller can **recompute from the stores itself** and compare.
 * That is the whole design: the receipt is a claim with its own falsifier
 * attached, not a status.
 *
 * ── What deletion means against these stores ─────────────────────
 *
 * Both stores are append-only for *corrections*: `revoke()` adds a `revokedAt`
 * and rewrites nothing, so the history of what the user asked for stays
 * inspectable. Deletion is different in kind and both stores say so with a
 * separate verb — `deleteScope()` removes the rows outright and returns how
 * many it removed.
 *
 * Deletion here is therefore a **purge**, not a mass revocation. Revoking
 * everything would leave a profile derivable-from-nothing but the events still
 * on disk, and a user who asked to be forgotten would have been given a filter
 * rather than a deletion. The remainder counts below are what makes the
 * difference checkable: after a purge they are zero, and after a mass revoke
 * they would not be.
 *
 * ── The profile is not stored, and that is a claim too ───────────
 *
 * A derived profile is recomputed per read and never persisted, so there is no
 * third store to purge. `remainingPersistedProfileCount` exists to say that out
 * loud and keep saying it: if some later sprint adds a profile cache, whoever
 * adds it has to come here and decide what the number means, instead of the
 * cache quietly surviving a deletion that reports success.
 *
 * ── The two stores this purge was missing (UC-3.16, #202) ────────
 *
 * It deleted `feedbackEvents` and `memory` and stopped, which was one store
 * too few twice over.
 *
 * `behaviorFeedback` holds the legacy per-action counters — ignored, completed,
 * delayed, clarification outcomes — written on every user action and read by
 * the *shipped* `adaptiveService` classifier that labels a person avoidant,
 * inconsistent or disciplined. It is not dead: `agendaActionService` says in
 * its own comment that the legacy counter write "stays authoritative for this
 * sprint". Purging the event log while leaving it meant the derived label came
 * back byte-identical from a deletion that reported success.
 *
 * `profileProposals` holds self-description suggestions between proposing and
 * confirming. They are model-derived claims about a person, and a surviving one
 * can be confirmed *after* the deletion into a fresh memory record — so leaving
 * them made "delete everything" reversible from the outside. The thirty-minute
 * TTL bounds the window; it does not make the promise true inside it.
 *
 * `aiContextImports` is the same argument one step further out. A staged import
 * proposal holds short claims about a person written by *another company's*
 * model, and a surviving one can be confirmed after the deletion into fresh
 * memory records — with the relations still attached, so a confirm arriving
 * after a purge could even supersede a record the user re-entered by hand. It
 * purges here for the reason `profileProposals` does, and more urgently.
 *
 * ── The third store this purge gained (football fixtures MVP, Task 7) ────
 *
 * `footballFollows` — which clubs a user follows — purges here too now,
 * alongside `behaviorFeedback` and `profileProposals`. It is worth pausing on
 * because, unlike those two, a follow is something the user explicitly typed:
 * they picked "Barcelona" from a list, the same way they type a commitment's
 * title. That similarity is exactly what makes it tempting to file next to
 * `commitments` in the *kept* section below, and exactly why it belongs here
 * instead: the line this module draws is content versus belief, not typed
 * versus inferred. `memory` already purges `user_stated` facts identically to
 * `model_inferred` ones — the deletion above does not ask a memory record how
 * it was produced before removing it, because either way it is something the
 * product now *believes* about the person, derived from what they did or
 * said, not a record of what they did. A followed club is the same shape of
 * fact: it is not the user's own content the way a commitment or a plan is —
 * nothing is lost from their day if it goes — it is a belief the product
 * holds about them, and in this app's Arabic and Hebrew markets club
 * affiliation tracks nationality, religion and politics closely enough that
 * "the product believes I follow this club" is squarely what "forget me" is
 * for. `tests/personalization/deletionScopeCoverage.test.ts` carries the
 * fuller version of this reasoning against the full collection list; this
 * restates the line it draws rather than arguing it afresh.
 *
 * ── What is deliberately *not* purged here ───────────────────────
 *
 * `commitments`, `reminders`, `events`, `plans` and `planEvents` are the user's
 * own content, or built from it — a plan is their day, rebuilt each morning
 * out of their own commitments. This button is not a way to lose your week.
 *
 * `pressureDelivery` is the harder call and the answer is no. It is a per
 * commitment record of when the product last nudged and with what text, and
 * its live function is to *suppress* the next nudge for a cooldown. Deleting it
 * removes a brake rather than a belief: a user who asked to be forgotten would
 * be answered by the product immediately becoming free to push them again —
 * the loop #107 and #388 exist to refuse. It is keyed to commitments, which are
 * on the content side of the line, and it goes with them on account deletion,
 * where `deleteTree` already covers it.
 *
 * `memoryDismissals` (UC-3.16, #202) goes too. A dismissal is the user's answer
 * to a suggestion, which argues for keeping it the way consent is kept — but
 * what it stores is a fingerprint naming a window of the day read off their
 * behaviour, which is a derived claim about them. Purging it can only cost a
 * suggestion being offered again, which nothing saves until they press Keep;
 * keeping it would leave a behavioural fact behind a button that says
 * "everything".
 *
 * Every one of these decisions is enumerated against `USER_SCOPED_COLLECTIONS`
 * in `tests/personalization/deletionScopeCoverage.test.ts`, so the next store
 * added is classified deliberately instead of missed in silence.
 *
 * ── The limit of a uid-keyed purge ───────────────────────────────
 *
 * `scopeBehaviorFeedback` resolves `feedbackScopeId || conversationId ||
 * sessionId || userId || 'local'`, so counters can in principle be filed under
 * something that is not a uid. This purge does not reach those, and cannot.
 *
 * It is not reachable from the product: the authenticated entry point is
 * `feedbackScopeIdFor(uid)`, which passes `{ userId: uid }` and nothing else —
 * UC-1.0e (#144) closed the collapse-to-`'local'` hole there — and no
 * `/api/mobile/**` route reaches `applyAgendaAction` or `captureService`. The
 * one caller that can supply a conversation or session id is the frozen web
 * `POST /api/agenda/action`, which reads them out of an unauthenticated body.
 *
 * A row keyed that way does not land in the caller's tree at all: the path is
 * `users/{docIdForKey(conversationId)}/behaviorFeedback/…`, a *different* user
 * document. So it is equally outside `deleteTree('users/{uid}')` — it is a
 * scoping defect of the frozen route, not of this cascade, and moving it would
 * be guessing which uid an anonymous conversation belonged to. What is in
 * reach is done: the whole of `users/{uid}/behaviorFeedback` goes, whatever id
 * a row is filed under. `tests/personalization/deletionScopeCoverage.test.ts`
 * holds the product path to the uid so this stays true.
 */
import {
  PERSONALIZATION_CONTRACT_VERSION,
  PERSONALIZATION_SCHEMA_VERSION,
  type Instant,
  type PersonalizationDeletionReceipt,
} from '../../src/contracts/v1/personalizationContracts';
import {
  computeFeedbackInputDigest,
  resolveFeedbackWindowDays,
} from '../feedback/feedbackAggregation';
import type { FeedbackEventStore } from '../../src/contracts/v1/feedbackContracts';
import type { RuntimeMemoryStore } from '../../src/contracts/v1/memoryContracts';
import { getStorage } from '../storage';
import { releaseUnfollowedFixtures } from '../football/projectFixtures';
import {
  AI_CONTEXT_IMPORTS,
  BEHAVIOR_FEEDBACK,
  FOOTBALL_FOLLOWS,
  GOAL_GRAPH_PROPOSALS,
  GOAL_LINEAGES,
  GOAL_PLAN_CLAIMS,
  GOAL_PLAN_OUTCOMES,
  GOAL_PLAN_TIMES,
  GOAL_PLANS,
  GOAL_STATEMENT_ACCEPTS,
  GOAL_STATEMENT_PREVIEWS,
  INTELLIGENCE_OBSERVATIONS,
  INTELLIGENCE_PROPOSALS,
  INTELLIGENCE_RUNS,
  INTELLIGENCE_MONITORS,
  INTELLIGENCE_GMAIL_SCANS,
  INTELLIGENCE_SOURCE_MARKERS,
  INTELLIGENCE_AUTO_ADDS,
  MEMORY_DISMISSALS,
  PROFILE_PROPOSALS,
  userCol,
  userDoc,
} from '../storage/paths';
import type { StorageAdapter } from '../storage/storageAdapter';
import { randomUUID } from 'node:crypto';
import { completeAbandonedWithdrawal, liveWithdrawalOwnsFence, PersonalizationWithdrawalBusyError } from '../consents/personalizationConsentService';

export interface PersonalizationDeletionInput {
  readonly scopeId: string;
  /** From the caller, for receipts and stored times. The one clock read here judges a withdrawal lease (R27-001). */
  readonly now: Instant;
  readonly feedbackEvents: FeedbackEventStore;
  readonly runtimeMemory: RuntimeMemoryStore;
  /**
   * Where the two derived stores that are not ports live. Optional with a
   * `getStorage()` default, so every existing caller — the frozen web control
   * centre, the release route, the mobile delete-all — gains the purge without
   * being edited.
   */
  readonly storage?: StorageAdapter;
  /** Run with the receipt while the fence is still closed, before it reopens (R32-003); a throw keeps it closed. */
  readonly beforeReopen?: (receipt: PersonalizationDeletionReceipt) => Promise<void>;
  /** How often a running step renews its lease (tests shorten it). */
  readonly heartbeatMs?: number;
  /** Run once the purge holds the fence, before anything is erased; skipped when the purge is refused. */
  readonly onFenced?: () => Promise<void>;
  /** How long the purge waits behind a live withdrawal (tests shorten it). */
  readonly withdrawalWait?: { readonly attempts: number; readonly delayMs: number };
  /**
   * The window the profile would have been derived over. It enters the digest,
   * so the caller and the receipt must agree on it or the recomputation will
   * not match — which is the check working, not a bug.
   */
  readonly windowDays?: number;
}

/**
 * The digest of the derivation input for a scope holding nothing.
 *
 * **This function never reads a store, and that limits what the digest proves.**
 * It is a pure function of `(scopeId, now, windowDays)`, so
 * `receipt.emptyStateDigest === emptyStateDigestFor(scopeId, now)` holds even if
 * the deletion did nothing at all — a verifier comparing only those two is
 * comparing one function with itself.
 *
 * What it *does* give the verifier is a value bound to this scope and this
 * instant, which is what stops one user's receipt from verifying another's
 * deletion, or last week's from verifying today's. The load-bearing proof of
 * emptiness is the remainder counts, which are re-listed from the stores after
 * the deletes — and `list()` includes revoked events by default while
 * `listAll()` shows revoked records, so a partial purge or a revoke-instead-of-
 * purge is caught there. The tests assert both, and say which is doing the work.
 *
 * Exported because **#42 has to be able to compute this without calling us**.
 * A receipt whose proof can only be produced by the module under test is not a
 * proof; the verifier needs its own path to the same number.
 *
 * `baseline: null` is deliberate. `deleteScope` removes the baseline row with
 * everything else, so a post-deletion aggregation reads no baseline — passing
 * anything else here would compute the digest of a state that does not exist.
 */
export function emptyStateDigestFor(scopeId: string, now: Instant, windowDays?: number): string {
  return computeFeedbackInputDigest({
    events: [],
    baseline: null,
    scopeId,
    now,
    windowDays: resolveFeedbackWindowDays(windowDays),
  });
}

const WITHDRAWAL_WAIT = { attempts: 40, delayMs: 250 } as const;

/** A purge still running after this long, on the server's clock, is taken to have died. */
const STALE_PURGE_MS = 10 * 60_000;

function livePurgeOwnsFence(fence: unknown, nowMs: number): boolean {
  const current = fence as { state?: unknown; purgeLeaseAt?: unknown; startedAt?: unknown } | undefined;
  if (current?.state !== 'purging') return false;
  const since = typeof current.purgeLeaseAt === 'string' ? Date.parse(current.purgeLeaseAt)
    : typeof current.startedAt === 'string' ? Date.parse(current.startedAt) : Number.NaN;
  return Number.isFinite(since) && nowMs - since < STALE_PURGE_MS;
}

/** This purge's fence, still closed, with its lease marked run out; never a successor's. */
async function abandonPurgeLease(storage: StorageAdapter, scopeId: string, epoch: number, owner: string): Promise<void> {
  await storage.runTransaction(async (tx) => {
    const user = await tx.get<Record<string, unknown>>(userDoc(scopeId));
    const fence = (user?.personalizationPurge ?? {}) as Record<string, unknown>;
    if (fence.state !== 'purging' || fence.epoch !== epoch || fence.purgeOwner !== owner) return;
    tx.merge(userDoc(scopeId), { personalizationPurge: { ...fence, purgeLeaseAt: new Date(0).toISOString() } });
  });
}

/** Moves the fence to `purging` at a new epoch, or null while a live withdrawal owns it. */
async function takePurgeFence(
  storage: StorageAdapter,
  scopeId: string,
  now: Instant,
): Promise<{ epoch: number; owner: string; abandonedWithdrawal: boolean } | null> {
  return storage.runTransaction(async (tx) => {
    const user = await tx.get<Record<string, unknown>>(userDoc(scopeId));
    // The server's clock, read here: the one clock this module reads, and only
    // to judge another operation's lease.
    if (liveWithdrawalOwnsFence(user?.personalizationPurge, Date.now())) return null;
    // One purge at a time (M5B2A-R29-001): a live one keeps the fence; a dead one is taken over.
    if (livePurgeOwnsFence(user?.personalizationPurge, Date.now())) return null;
    const abandonedWithdrawal = (user?.personalizationPurge as { state?: unknown } | undefined)?.state === 'withdrawing';
    const prior = user?.personalizationPurge as { epoch?: unknown } | undefined;
    const epoch = Number.isSafeInteger(prior?.epoch) && (prior!.epoch as number) >= 0
      ? (prior!.epoch as number) + 1 : 1;
    const owner = randomUUID();
    const personalizationPurge = { state: 'purging', epoch, startedAt: now, purgeOwner: owner, purgeLeaseAt: new Date().toISOString() };
    if (user) tx.merge(userDoc(scopeId), { personalizationPurge });
    else tx.set(userDoc(scopeId), { personalizationPurge });
    return { epoch, owner, abandonedWithdrawal };
  });
}

/**
 * Purges every trace of a scope and returns the receipt for it.
 *
 * The remainders are read **after** the deletes, from the stores, by listing —
 * not by subtracting what `deleteScope` claimed to remove from what was there
 * before. Trusting the return value would make the receipt a restatement of the
 * delete call's own opinion, and the one failure this must catch is a delete
 * that reports a count and leaves rows behind.
 */
export async function deletePersonalizationScope(
  input: PersonalizationDeletionInput,
): Promise<PersonalizationDeletionReceipt> {
  const storage = input.storage ?? getStorage();

  // A live withdrawal keeps the fence until it is done (M5B2A-R26-001): the
  // purge waits for it. Lease expiry is judged on this server's own clock at
  // each attempt, never on `now`, which some callers take from a request body
  // (R27-001). A withdrawal whose lease ran out is taken over and completed —
  // store off and answer declined, what it set out to record — so the two
  // consent records never disagree after the purge (R27-002).
  const wait = input.withdrawalWait ?? WITHDRAWAL_WAIT;
  let taken: { epoch: number; owner: string; abandonedWithdrawal: boolean } | null = null;
  for (let attempt = 1; taken === null; attempt += 1) {
    taken = await takePurgeFence(storage, input.scopeId, input.now);
    if (taken !== null) break;
    if (attempt >= wait.attempts) throw new PersonalizationWithdrawalBusyError();
    await new Promise((resolve) => setTimeout(resolve, wait.delayMs));
  }
  const purgeEpoch = taken.epoch;
  const purgeOwner = taken.owner;
  // Still this purge's fence (M5B2A-R29-001): one taken over after its lease
  // ran out stops at the next step instead of erasing under its successor.
  // Checked and renewed in one transaction before every erasing step and the
  // caller's hook (R30-004): a long purge keeps its lease alive as it works,
  // so it is never mistaken for a dead one while it is still erasing.
  const stillOwns = async (): Promise<void> => {
    await storage.runTransaction(async (tx) => {
      const user = await tx.get<Record<string, unknown>>(userDoc(input.scopeId));
      const fence = (user?.personalizationPurge ?? {}) as Record<string, unknown>;
      if (fence.state !== 'purging' || fence.epoch !== purgeEpoch || fence.purgeOwner !== purgeOwner) {
        throw new Error('personalization purge barrier changed');
      }
      tx.merge(userDoc(input.scopeId), { personalizationPurge: { ...fence, purgeLeaseAt: new Date().toISOString() } });
    });
  };
  // While a step runs, its lease is kept alive (R32-002): a long sweep is
  // never taken for a dead purge, so no successor erases beside it. A process
  // that dies stops beating, and its lease runs out as before.
  const owned = async (step: () => Promise<unknown>): Promise<void> => {
    await stillOwns();
    const beat = setInterval(() => { void stillOwns().catch(() => undefined); }, input.heartbeatMs ?? HEARTBEAT_MS);
    (beat as { unref?: () => void }).unref?.();
    try { await step(); } finally { clearInterval(beat); }
  };
  let receipt: PersonalizationDeletionReceipt | undefined;
  // A step that fails gives this purge's lease up at once, the fence still
  // closed (M5B2A-R31-002): a retry takes it over instead of waiting out ten
  // minutes behind an operation that has already ended.
  try {
    if (taken.abandonedWithdrawal) await completeAbandonedWithdrawal(input.scopeId, input.now, { storage });
    // The caller's own erasures that must not happen on a refusal (R28-002): run
    // only once the fence is held.
    if (input.onFenced) await owned(input.onFenced);

    // Derived stores first, the user's memory rows last. If any step throws, the
    // user has had *more* erased than they asked for, never less, and the caller
    // still refuses to report success — see `deleteAllMemory`.
    await owned(() => input.feedbackEvents.deleteScope(input.scopeId));
    await owned(() => clearUserCollection(storage, input.scopeId, BEHAVIOR_FEEDBACK));
    await owned(() => clearUserCollection(storage, input.scopeId, PROFILE_PROPOSALS));
    await owned(() => clearUserCollection(storage, input.scopeId, AI_CONTEXT_IMPORTS));
    await owned(() => clearUserCollection(storage, input.scopeId, MEMORY_DISMISSALS));
    await owned(() => clearUserCollection(storage, input.scopeId, FOOTBALL_FOLLOWS));
    // Steps a model (or a template) proposed for the user's goals and nobody
    // confirmed yet (CL3). Inferred, like `profileProposals`, so they go; the
    // Commitments and Habits the user already confirmed out of them, and the
    // `goalGraphLinks` naming those, are the user's own work and stay.
    await owned(() => clearUserCollection(storage, input.scopeId, GOAL_GRAPH_PROPOSALS));
    // M3a's plan drafts and their coordination/history rows are all rooted in a
    // goal memory. A delete-all-memory request removes that root, so retaining
    // any of these would leave generated plan text or a replayable acceptance
    // behind after the memory store itself is empty.
    await owned(() => clearUserCollection(storage, input.scopeId, GOAL_PLANS));
    await owned(() => clearUserCollection(storage, input.scopeId, GOAL_PLAN_TIMES));
    await owned(() => clearUserCollection(storage, input.scopeId, GOAL_PLAN_OUTCOMES));
    await owned(() => clearUserCollection(storage, input.scopeId, GOAL_PLAN_CLAIMS));
    await owned(() => clearUserCollection(storage, input.scopeId, GOAL_LINEAGES));
    await owned(() => clearUserCollection(storage, input.scopeId, GOAL_STATEMENT_PREVIEWS));
    await owned(() => clearUserCollection(storage, input.scopeId, GOAL_STATEMENT_ACCEPTS));
    await owned(() => clearUserCollection(storage, input.scopeId, INTELLIGENCE_OBSERVATIONS));
    await owned(() => clearUserCollection(storage, input.scopeId, INTELLIGENCE_PROPOSALS));
    await owned(() => clearUserCollection(storage, input.scopeId, INTELLIGENCE_RUNS));
    await owned(() => clearUserCollection(storage, input.scopeId, INTELLIGENCE_MONITORS));
    // The week-scan cursor (2026-10-06): content-free, but it says when this
    // person's mail was read, so it goes with everything else read from it.
    await owned(() => clearUserCollection(storage, input.scopeId, INTELLIGENCE_GMAIL_SCANS));
    await owned(() => clearUserCollection(storage, input.scopeId, INTELLIGENCE_SOURCE_MARKERS));
    await owned(() => clearUserCollection(storage, input.scopeId, INTELLIGENCE_AUTO_ADDS));
    // With the follows gone, the matches they projected stop holding time: an
    // unfollow drop, never a dismissal, so following again brings them back.
    // The commitments themselves are kept as dropped history, like any other
    // commitment this purge leaves alone (football fixtures, final review I1).
    await owned(() => releaseUnfollowedFixtures(input.scopeId, input.now, { storage }));
    await owned(() => input.runtimeMemory.deleteScope(input.scopeId));

    // The remainders are counted, and the caller's own checks run, while the
    // fence is still closed (R32-003): a write that lands after the sweep is
    // refused, or counted — never one that survives a receipt of success.
    await stillOwns();
    receipt = await receiptFor(storage, input);
    if (input.beforeReopen) await owned(() => input.beforeReopen!(receipt!));

    await storage.runTransaction(async (tx) => {
      const user = await tx.get<Record<string, unknown>>(userDoc(input.scopeId));
      const current = user?.personalizationPurge as { state?: unknown; epoch?: unknown; purgeOwner?: unknown } | undefined;
      if (current?.state !== 'purging' || current.epoch !== purgeEpoch || current.purgeOwner !== purgeOwner) {
        throw new Error('personalization purge barrier changed');
      }
      tx.merge(userDoc(input.scopeId), {
        personalizationPurge: { state: 'active', epoch: purgeEpoch, completedAt: input.now, purgeOwner: null, purgeLeaseAt: null },
      });
    });
  } catch (error) {
    await abandonPurgeLease(storage, input.scopeId, purgeEpoch, purgeOwner).catch(() => undefined);
    throw error;
  }
  return receipt!;
}

const HEARTBEAT_MS = 60_000;

async function receiptFor(storage: StorageAdapter, input: PersonalizationDeletionInput): Promise<PersonalizationDeletionReceipt> {
  return {
    version: PERSONALIZATION_CONTRACT_VERSION,
    schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
    scopeId: input.scopeId,
    deletedAt: input.now,
    remainingFeedbackEventCount: (await input.feedbackEvents.list({ scopeId: input.scopeId })).length,
    remainingRuntimeMemoryRecordCount: (await input.runtimeMemory.listAll(input.scopeId)).length,
    remainingBehaviorFeedbackCount: (await storage.list(userCol(input.scopeId, BEHAVIOR_FEEDBACK))).length,
    remainingProfileProposalCount: (await storage.list(userCol(input.scopeId, PROFILE_PROPOSALS))).length,
    remainingAiContextImportCount: (await storage.list(userCol(input.scopeId, AI_CONTEXT_IMPORTS))).length,
    remainingMemoryDismissalCount: (await storage.list(userCol(input.scopeId, MEMORY_DISMISSALS))).length,
    remainingFootballFollowsCount: (await storage.list(userCol(input.scopeId, FOOTBALL_FOLLOWS))).length,
    remainingGoalStepProposalCount: (await storage.list(userCol(input.scopeId, GOAL_GRAPH_PROPOSALS))).length,
    // Structurally zero: nothing persists a profile. See the header.
    remainingPersistedProfileCount: 0,
    emptyStateDigest: emptyStateDigestFor(input.scopeId, input.now, input.windowDays),
  };
}

/**
 * Everything in one of the scope's derived collections, a document at a time.
 *
 * Not `deleteTree`: that takes a *document* path and these are collections, and
 * the path guard rejects one outright rather than deleting nothing quietly.
 *
 * Collection-wide rather than by the one id the store derives. `behaviorFeedback`
 * files its document under `docIdForKey(scopeId)` and `StorageBehaviorFeedbackStore.clear`
 * removes exactly that path, which is right for the row the product writes and
 * silently insufficient for any other row that has ever landed in the same
 * user's collection. Deleting the collection is a superset of the store's own
 * `clear` and cannot be outlived by a row filed under a different id.
 *
 * It reaches only `users/{scopeId}/…`, which is the limit of what a uid-keyed
 * purge can promise — see the header on the scope key.
 */
async function clearUserCollection(
  storage: StorageAdapter,
  scopeId: string,
  collection: string,
): Promise<void> {
  const path = userCol(scopeId, collection);
  for (const row of await storage.list(path)) {
    await storage.delete(`${path}/${row.id}`);
  }
}
