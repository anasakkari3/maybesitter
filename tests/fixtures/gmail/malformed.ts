/**
 * Payloads that are valid JSON and HTTP 200, but violate the documented shape.
 *
 * Each one is a specific way a permissive parser silently produces garbage.
 * These are not "corrupt bytes" tests — they are contract-violation tests, and
 * every one of them must be REJECTED, not coerced.
 */
import type { WireResponseFixture } from './wireTypes';

const JSON_HEADERS = { 'content-type': 'application/json; charset=UTF-8' };

/**
 * history.list 200 with NO `historyId`. Documented as always present.
 * If Phase B stores `undefined` as the cursor it loses its place silently.
 */
export const MALFORMED_HISTORY_NO_HISTORY_ID: WireResponseFixture<Record<string, unknown>> = {
  status: 200,
  headers: JSON_HEADERS,
  body: { history: [{ id: '2418871', messages: [{ id: 'abc', threadId: 'def' }] }] },
};

/**
 * history.list 200 where historyId is a NUMBER, not a string.
 * 2418890 is safe in a double, but Gmail ids are uint64 and large ones are not;
 * any code that does Number(historyId) can lose precision. Reject the type.
 */
export const MALFORMED_HISTORY_NUMERIC_ID: WireResponseFixture<Record<string, unknown>> = {
  status: 200,
  headers: JSON_HEADERS,
  body: { history: [], historyId: 2418890 },
};

/**
 * history.list 200 whose `nextPageToken` is the SAME token that was just sent.
 * Valid JSON, valid types, infinite loop. The adapter already guards this
 * (`Repeated Gmail page token`); the transport must not defeat the guard.
 */
export const MALFORMED_HISTORY_REPEATING_PAGE_TOKEN: WireResponseFixture<
  Record<string, unknown>
> = {
  status: 200,
  headers: JSON_HEADERS,
  body: {
    history: [{ id: '2418871' }],
    nextPageToken: '11223344556677889900',
    historyId: '2418890',
  },
};

/** messages.list 200 where `messages` is an object rather than an array. */
export const MALFORMED_MESSAGES_LIST_NOT_ARRAY: WireResponseFixture<Record<string, unknown>> = {
  status: 200,
  headers: JSON_HEADERS,
  body: { messages: { id: '19a1f2c3d4e5f601', threadId: '19a1f2c3d4e5f600' }, resultSizeEstimate: 1 },
};

/** messages.get 200 with `id` present but null, and no threadId. */
export const MALFORMED_MESSAGE_NULL_ID: WireResponseFixture<Record<string, unknown>> = {
  status: 200,
  headers: JSON_HEADERS,
  body: { id: null, labelIds: ['INBOX'], snippet: 'x', historyId: '2418871' },
};

/**
 * messages.get 200 whose body.data is not valid base64url (contains '+' and '/'
 * from standard base64, plus '=' padding mid-string). A decoder that guesses
 * the alphabet produces wrong bytes rather than an error.
 */
export const MALFORMED_MESSAGE_BAD_BASE64: WireResponseFixture<Record<string, unknown>> = {
  status: 200,
  headers: JSON_HEADERS,
  body: {
    id: '19a1f2c3d4e5f601',
    threadId: '19a1f2c3d4e5f600',
    internalDate: '1789632842000',
    payload: {
      partId: '',
      mimeType: 'text/plain',
      filename: '',
      headers: [],
      body: { size: 12, data: 'SGks+/DQo=Zm9v' },
    },
  },
};

/** messages.get 200 where internalDate is not parseable as epoch ms. */
export const MALFORMED_MESSAGE_BAD_INTERNAL_DATE: WireResponseFixture<Record<string, unknown>> = {
  status: 200,
  headers: JSON_HEADERS,
  body: {
    id: '19a1f2c3d4e5f601',
    threadId: '19a1f2c3d4e5f600',
    internalDate: 'Thu, 17 Sep 2026 09:14:02 +0300',
    labelIds: ['INBOX'],
  },
};

/**
 * getProfile 200 with no emailAddress. The account-identity check has nothing
 * to compare against; it must FAIL CLOSED rather than pass by vacuity.
 */
export const MALFORMED_PROFILE_NO_EMAIL: WireResponseFixture<Record<string, unknown>> = {
  status: 200,
  headers: JSON_HEADERS,
  body: { messagesTotal: 48211, threadsTotal: 31004, historyId: '2418890' },
};

/**
 * A 200 whose body is JSON but an ARRAY at the top level. Sometimes what a
 * captive portal or a misconfigured proxy returns.
 */
export const MALFORMED_TOP_LEVEL_ARRAY: WireResponseFixture<unknown[]> = {
  status: 200,
  headers: JSON_HEADERS,
  body: [],
};
