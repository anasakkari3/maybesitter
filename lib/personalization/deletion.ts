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
import { BEHAVIOR_FEEDBACK, FOOTBALL_FOLLOWS, PROFILE_PROPOSALS, userCol } from '../storage/paths';
import type { StorageAdapter } from '../storage/storageAdapter';

export interface PersonalizationDeletionInput {
  readonly scopeId: string;
  /** From the caller. This module never reads a clock. */
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

  // Derived stores first, the user's memory rows last. If any step throws, the
  // user has had *more* erased than they asked for, never less, and the caller
  // still refuses to report success — see `deleteAllMemory`.
  await input.feedbackEvents.deleteScope(input.scopeId);
  await clearUserCollection(storage, input.scopeId, BEHAVIOR_FEEDBACK);
  await clearUserCollection(storage, input.scopeId, PROFILE_PROPOSALS);
  await clearUserCollection(storage, input.scopeId, FOOTBALL_FOLLOWS);
  // With the follows gone, the matches they projected stop holding time: an
  // unfollow drop, never a dismissal, so following again brings them back.
  // The commitments themselves are kept as dropped history, like any other
  // commitment this purge leaves alone (football fixtures, final review I1).
  await releaseUnfollowedFixtures(input.scopeId, input.now, { storage });
  await input.runtimeMemory.deleteScope(input.scopeId);

  return {
    version: PERSONALIZATION_CONTRACT_VERSION,
    schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
    scopeId: input.scopeId,
    deletedAt: input.now,
    remainingFeedbackEventCount: (await input.feedbackEvents.list({ scopeId: input.scopeId })).length,
    remainingRuntimeMemoryRecordCount: (await input.runtimeMemory.listAll(input.scopeId)).length,
    remainingBehaviorFeedbackCount: (await storage.list(userCol(input.scopeId, BEHAVIOR_FEEDBACK))).length,
    remainingProfileProposalCount: (await storage.list(userCol(input.scopeId, PROFILE_PROPOSALS))).length,
    remainingFootballFollowsCount: (await storage.list(userCol(input.scopeId, FOOTBALL_FOLLOWS))).length,
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
