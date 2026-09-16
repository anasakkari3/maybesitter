/**
 * Which clubs a user follows (football fixtures MVP, Task 7).
 *
 * ── One document, not one row per club ────────────────────────────────────
 * `paths.ts` explains why `FOOTBALL_FOLLOWS` exists and how it differs from
 * `consents`; this module is what reads and writes it. Everything a user
 * follows lives in a single array field on one fixed document
 * (`userSubDoc(uid, FOOTBALL_FOLLOWS, 'clubs')`) rather than one document per
 * club. The MVP screen is "pick from a short curated list" and the only read
 * anything ever needs is "give me the whole list back" — a collection of
 * one-row-per-club documents would turn a single read into a query, for a
 * cardinality (a handful of clubs, at most) that never justifies it. An
 * array from day one, per the brief: the alternative is a migration the first
 * time somebody wants a second club, to buy nothing today.
 *
 * ── An unknown club id is refused at the door ─────────────────────────────
 * The id becomes a document key the nightly sync (`fixtureStore.ts`,
 * `footballDataProvider.ts`) carries for ever once accepted. `clubById` is
 * the same curated list `footballDataProvider` trusts completely (see
 * `clubs.ts`'s own header) — so a typo, or an id for a club that was simply
 * never added to the list, would otherwise become a permanent, silent no-op
 * in every future sync run, indistinguishable from a real club that just
 * never happens to have fixtures this week. Rejecting it here, synchronously,
 * before anything is written, is the one point in the system that can still
 * name the problem instead of quietly absorbing it forever.
 *
 * ── Duplicates collapse before validation ─────────────────────────────────
 * The caller's list is deduplicated with a `Set` before `clubById` ever runs,
 * so sending the same club twice is not itself an error — only an id the
 * curated list does not contain is.
 *
 * ── The collection-group read ─────────────────────────────────────────────
 * `listFollowedClubIdsAcrossUsers` is `listGroup(FOOTBALL_FOLLOWS)` rather
 * than a per-user loop: the nightly sync's whole reason for calling it is to
 * learn which clubs have *any* follower at all, so it can skip asking the
 * provider about every curated club nobody follows. A per-user loop would
 * need every uid up front, which is exactly the thing this call exists to
 * avoid needing — and it is why `FOOTBALL_FOLLOWS` is a subcollection under
 * `users/{uid}` rather than, say, a single global document: a collection
 * group is queryable across every user's copy, a single document is not.
 */
import { getStorage, type StorageAdapter } from '../storage';
import { FOOTBALL_FOLLOWS, userSubDoc } from '../storage/paths';
import { clubById } from './clubs';

/** The one fixed document id every user's follow list lives at. */
const CLUBS_DOC_ID = 'clubs';

/** The stored shape at `userSubDoc(uid, FOOTBALL_FOLLOWS, 'clubs')`. */
interface FollowedClubsDoc {
  readonly clubIds: readonly string[];
  readonly updatedAt: string;
}

export interface FollowedClubsDeps {
  readonly storage?: StorageAdapter;
}

function storageOf(deps: FollowedClubsDeps): StorageAdapter {
  return deps.storage ?? getStorage();
}

/** Empty for a user who has never followed anything — never an error. */
export async function getFollowedClubs(
  uid: string,
  deps: FollowedClubsDeps = {},
): Promise<readonly string[]> {
  const storage = storageOf(deps);
  const doc = await storage.get<FollowedClubsDoc>(userSubDoc(uid, FOOTBALL_FOLLOWS, CLUBS_DOC_ID));
  return doc?.clubIds ?? [];
}

/**
 * Replaces the user's whole follow list.
 *
 * Rejects, naming the offending id, if any of them is not in the curated
 * club list — see the module header for why that has to happen here, before
 * anything is written.
 */
export async function setFollowedClubs(
  uid: string,
  clubIds: readonly string[],
  now: string,
  deps: FollowedClubsDeps = {},
): Promise<readonly string[]> {
  // `Array.from`, not `[...new Set(...)]`: `tsconfig.json` targets `es5`
  // without `downlevelIteration`, so spreading a `Set` needs this form
  // instead -- see `Array.from` used the same way across `lib/`.
  const deduped = Array.from(new Set(clubIds));
  for (const clubId of deduped) {
    if (!clubById(clubId)) {
      throw new Error(`unknown club id "${clubId}": not in the curated club list (see lib/football/clubs.ts)`);
    }
  }
  const storage = storageOf(deps);
  await storage.set(userSubDoc(uid, FOOTBALL_FOLLOWS, CLUBS_DOC_ID), {
    clubIds: deduped,
    updatedAt: now,
  } satisfies FollowedClubsDoc);
  return deduped;
}

/**
 * Every club id followed by anybody, deduplicated across all users.
 *
 * A collection-group read, not a per-user loop — see the module header.
 */
export async function listFollowedClubIdsAcrossUsers(
  deps: FollowedClubsDeps = {},
): Promise<readonly string[]> {
  const storage = storageOf(deps);
  const rows = await storage.listGroup<FollowedClubsDoc>(FOOTBALL_FOLLOWS);
  const ids = new Set<string>();
  for (const row of rows) {
    for (const clubId of row.data.clubIds) ids.add(clubId);
  }
  return Array.from(ids);
}

/**
 * Every uid that currently follows at least one club, deduplicated
 * (football fixtures MVP, Task 9).
 *
 * The same collection-group read `listFollowedClubIdsAcrossUsers` runs, but
 * keeps the uid each row belongs to instead of discarding it — the nightly
 * sync needs to know *whose* fixtures to project into commitments
 * (`projectFixturesForUser`), not merely which clubs have a follower. The uid
 * is read off `row.path` (`users/{uid}/footballFollows/clubs`, segment 1)
 * rather than a second lookup, because `listGroup` already hands back the
 * full document path for free — see `StorageReader.listGroup`.
 *
 * A doc with an empty `clubIds` (a user who unfollowed everything, but whose
 * fixed one-document-per-account shape `setFollowedClubs` still wrote)
 * contributes no uid: projecting for someone following nothing would only
 * ever produce an all-zero tally, and this is the one place that can skip
 * that read entirely instead of paying it every night forever.
 */
export async function listFollowedUserIds(
  deps: FollowedClubsDeps = {},
): Promise<readonly string[]> {
  const storage = storageOf(deps);
  const rows = await storage.listGroup<FollowedClubsDoc>(FOOTBALL_FOLLOWS);
  const uids = new Set<string>();
  for (const row of rows) {
    if (row.data.clubIds.length === 0) continue;
    // `userSubDoc(uid, FOOTBALL_FOLLOWS, 'clubs')` is `users/{uid}/footballFollows/clubs`;
    // segment 0 is the literal `users`, segment 1 is the uid.
    const uid = row.path.split('/')[1];
    if (uid) uids.add(uid);
  }
  return Array.from(uids);
}
