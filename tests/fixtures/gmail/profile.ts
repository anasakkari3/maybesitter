/**
 * users.getProfile fixtures.
 * Source: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
 *
 * `emailAddress` is the only field in ANY Gmail response that identifies the
 * account the token belongs to. Phase B's account-identity check compares this
 * against the connection's stored address; it must never trust the stored
 * string on its own.
 */
import type { WireProfile, WireResponseFixture } from './wireTypes';

/** The account Phase B's fixtures pretend to be connected to. */
export const FIXTURE_ACCOUNT = 'owner@example.com';
/** A different account — used to prove the identity check actually fails. */
export const FIXTURE_OTHER_ACCOUNT = 'someone.else@example.com';

/** GET /gmail/v1/users/me/profile -> 200 */
export const PROFILE_OK: WireResponseFixture<WireProfile> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: {
    emailAddress: FIXTURE_ACCOUNT,
    messagesTotal: 48211,
    threadsTotal: 31004,
    historyId: '2418890',
  },
};

/** Same call, but the token belongs to a different mailbox. Identity check MUST reject. */
export const PROFILE_WRONG_ACCOUNT: WireResponseFixture<WireProfile> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: {
    emailAddress: FIXTURE_OTHER_ACCOUNT,
    messagesTotal: 12,
    threadsTotal: 9,
    historyId: '1007',
  },
};
