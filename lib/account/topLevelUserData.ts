/**
 * User-linked documents that do not live in the user's tree (UC-1.5, #149).
 *
 * `deleteTree('users/{uid}')` removes everything under the account. It cannot
 * remove a document that carries the uid in a *field* at the top level, and
 * those exist for good reasons: the scheduler queries every due job across all
 * accounts, so jobs are top-level with `uid` on the document.
 *
 * A collection missing from this list is data that survives its owner's
 * deletion, silently. So the list is not documentation — it is what the sweep
 * iterates, and `tests/account/topLevelDeletionCoverage.test.ts` fails if a
 * top-level collection the codebase knows about is neither listed here nor
 * explicitly declared to hold nothing about a person.
 */
import { INCIDENTS } from '../storage/paths';
import { JOBS } from '../scheduler/storageSchedulerStore';

export interface TopLevelUserCollection {
  /** The top-level collection id. */
  collection: string;
  /** The field on each document holding the owner's uid. */
  field: string;
  /** Why this data exists outside the tree, in one line. */
  reason: string;
}

export const TOP_LEVEL_USER_COLLECTIONS: readonly TopLevelUserCollection[] = [
  {
    collection: JOBS,
    field: 'uid',
    reason: 'the scheduler claims due work across all accounts in one query, so a job cannot be nested under its owner',
  },
  {
    collection: INCIDENTS,
    field: 'participantId',
    reason: 'an operator writes a trust incident about an account, and it must stay readable when the account cannot be',
  },
] as const;

/**
 * Top-level collections that deliberately hold nothing linked to a person.
 *
 * Named so the coverage test can tell "deletion does not need this" from
 * "nobody has thought about this yet".
 */
export const TOP_LEVEL_COLLECTIONS_WITHOUT_USER_DATA: readonly string[] = [
  // The service's daily model spend (#160): one document per UTC day, holding
  // a count and nothing else. No uid appears in it, and the per-account half
  // of the same guard lives at `users/{uid}/usage` and is deleted with the
  // tree.
  'llmUsage',
  // Written by the deletion engine itself, keyed by the peppered subject hash.
  // Removing them as part of a deletion would erase the proof that it happened.
  'accountDeletions',
  'deletionReceipts',
  // A football match (football fixtures MVP, Task 5): a shared row about a
  // game, not a fact about any one account. No uid appears in it — the
  // per-account halves are `footballFollows` and `externalTaskRefs`, which
  // *are* user-scoped and go with the tree in the ordinary way.
  'fixtures',
  // When a curated club was last synced (football fixtures MVP, Task 9): a
  // fact about the club's own fetch history, keyed by clubId, holding no uid
  // and nothing a person typed. Deleting an account must not reset how
  // recently a club everybody else still follows was synced.
  'footballClubSyncState',
  // The early-access sign-up endpoint's global rate-limit window: one document
  // holding a count and a reset time. It is keyed by a fixed name, never by
  // an IP or an email, so there is nothing in it about anybody.
  'earlyAccessRateLimits',
] as const;

export interface TopLevelPreAccountCollection {
  /** The top-level collection id. */
  collection: string;
  /** Why this personal data exists outside any account, in one line. */
  reason: string;
  /** How a person gets it deleted, since account deletion cannot reach it. */
  deletion: string;
}

/**
 * Top-level collections holding personal data about people who may have no
 * account at all.
 *
 * Neither list above fits them. They are not linked to a uid, so the account
 * sweep has nothing to filter on, and they are not free of personal data. Putting them
 * in either list would be a false statement the coverage test would then
 * enforce. So they get their own declaration, with the route by which they
 * *are* deleted, and `tests/account/topLevelDeletionCoverage.test.ts` holds
 * each one to a reason and a deletion route.
 */
export const TOP_LEVEL_PRE_ACCOUNT_COLLECTIONS: readonly TopLevelPreAccountCollection[] = [
  {
    collection: 'earlyAccessRegistrations',
    reason: 'website tester sign-ups from people who may never create an account, so no uid exists to nest them under',
    deletion: 'on request to the privacy address, as the privacy policy "Early-access sign-up" section promises; retained only while early access runs',
  },
] as const;
