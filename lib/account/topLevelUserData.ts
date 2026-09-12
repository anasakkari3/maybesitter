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
  // Written by the deletion engine itself, keyed by the peppered subject hash.
  // Removing them as part of a deletion would erase the proof that it happened.
  'accountDeletions',
  'deletionReceipts',
] as const;
