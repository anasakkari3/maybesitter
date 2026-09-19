/**
 * users.history.list fixtures.
 * Source: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
 *         https://developers.google.com/workspace/gmail/api/guides/sync
 *
 * maxResults: default 100, maximum 500.
 * historyTypes[] filters to: messageAdded | messageDeleted | labelAdded | labelRemoved.
 *
 * CONTRACT TRAP, and the reason these fixtures are deliberately thin:
 * the `message` inside messagesAdded / labelsAdded is a Message stub — id,
 * threadId, labelIds. It carries no headers, no internalDate and no body.
 * `history.list` alone can never produce the `from` / `subject` / `text` /
 * `receivedAt` that `GmailMessagePayload` in lib/integrations/gmail/adapter.ts
 * requires. Phase B must follow each id with a users.messages.get.
 */
import type { WireHistoryListResponse, WireResponseFixture } from './wireTypes';
import { MSG_ID_1, MSG_ID_2, MSG_ID_3, THREAD_ID_1 } from './messages';

/** A cursor the mailbox still holds. */
export const HISTORY_CURSOR_FRESH = '2418800';
/** A cursor older than the retention window. See HISTORY_CURSOR_TOO_OLD_404. */
export const HISTORY_CURSOR_STALE = '1100042';
/** Page-2 cursor for history.list. */
export const HISTORY_PAGE_TOKEN = '11223344556677889900';

/** startHistoryId=HISTORY_CURSOR_FRESH&maxResults=2 -> 200, first of two pages. */
export const HISTORY_LIST_PAGE_1: WireResponseFixture<WireHistoryListResponse> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: {
    history: [
      {
        id: '2418871',
        messages: [{ id: MSG_ID_1, threadId: THREAD_ID_1 }],
        messagesAdded: [
          {
            message: {
              id: MSG_ID_1,
              threadId: THREAD_ID_1,
              labelIds: ['UNREAD', 'CATEGORY_PERSONAL', 'INBOX'],
            },
          },
        ],
      },
      {
        id: '2418879',
        messages: [{ id: MSG_ID_2, threadId: THREAD_ID_1 }],
        messagesAdded: [
          { message: { id: MSG_ID_2, threadId: THREAD_ID_1, labelIds: ['INBOX'] } },
        ],
      },
    ],
    nextPageToken: HISTORY_PAGE_TOKEN,
    historyId: '2418890',
  },
};

/**
 * Same call with pageToken=HISTORY_PAGE_TOKEN -> 200, last page.
 * Includes a labelsRemoved record, which is a change Phase B must ignore:
 * read-only means it reacts to nothing here except new message ids.
 */
export const HISTORY_LIST_PAGE_2: WireResponseFixture<WireHistoryListResponse> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: {
    history: [
      {
        id: '2418885',
        messages: [{ id: MSG_ID_3, threadId: '19a1f2c3d4e5f5aa' }],
        messagesAdded: [
          { message: { id: MSG_ID_3, threadId: '19a1f2c3d4e5f5aa', labelIds: ['INBOX'] } },
        ],
      },
      {
        id: '2418890',
        messages: [{ id: MSG_ID_1, threadId: THREAD_ID_1 }],
        labelsRemoved: [
          {
            message: {
              id: MSG_ID_1,
              threadId: THREAD_ID_1,
              labelIds: ['CATEGORY_PERSONAL', 'INBOX'],
            },
            labelIds: ['UNREAD'],
          },
        ],
      },
    ],
    historyId: '2418890',
  },
};

/**
 * Nothing changed since startHistoryId. `history` is ABSENT (not []), and
 * `historyId` still advances to the mailbox's current value — so the cursor
 * must be stored even on an empty read.
 */
export const HISTORY_LIST_EMPTY: WireResponseFixture<WireHistoryListResponse> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: { historyId: '2418890' },
};
