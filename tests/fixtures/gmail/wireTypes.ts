/**
 * Gmail REST v1 WIRE shapes, transcribed from Google's current reference docs.
 *
 * These are the shapes that come back from gmail.googleapis.com. They are NOT
 * the shapes `lib/integrations/gmail/adapter.ts` consumes: `GmailApiPort`
 * already takes a normalized `GmailHistoryPage`. Phase B's transport sits
 * BELOW that port and must map these wire shapes into it.
 *
 * Sources (fetched 2026-09-19):
 *  - users.getProfile     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
 *  - users.history.list   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
 *  - users.messages.list  https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
 *  - users.messages.get   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
 *  - Message resource     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
 *  - Format enum          https://developers.google.com/workspace/gmail/api/reference/rest/v1/Format
 *  - Error envelope       https://developers.google.com/workspace/gmail/api/guides/handle-errors
 *                         https://google.aip.dev/193
 *
 * Every numeric-looking id (`id`, `threadId`, `historyId`) is a STRING on the
 * wire. `sizeEstimate` and `size` are numbers. `internalDate` is a string
 * holding epoch milliseconds (int64).
 */

/** users.getProfile response. */
export interface WireProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  /** string, not number */
  historyId: string;
}

export interface WireHeader {
  name: string;
  value: string;
}

export interface WireMessagePartBody {
  attachmentId?: string;
  size: number;
  /** base64url-encoded body bytes. Absent for container parts and attachments. */
  data?: string;
}

export interface WireMessagePart {
  partId: string;
  mimeType: string;
  filename: string;
  headers?: WireHeader[];
  body: WireMessagePartBody;
  parts?: WireMessagePart[];
}

export interface WireMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  /** epoch ms as a decimal string */
  internalDate?: string;
  payload?: WireMessagePart;
  sizeEstimate?: number;
  /** format=RAW only: RFC 2822 message, base64url encoded */
  raw?: string;
}

/** users.messages.list response. */
export interface WireMessagesListResponse {
  /** ABSENT (not []) when there are no results. */
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate: number;
}

export interface WireHistoryRecord {
  id: string;
  messages?: Array<{ id: string; threadId: string }>;
  messagesAdded?: Array<{ message: WireMessage }>;
  messagesDeleted?: Array<{ message: WireMessage }>;
  labelsAdded?: Array<{ message: WireMessage; labelIds: string[] }>;
  labelsRemoved?: Array<{ message: WireMessage; labelIds: string[] }>;
}

/** users.history.list response. */
export interface WireHistoryListResponse {
  /** ABSENT when nothing changed since startHistoryId. */
  history?: WireHistoryRecord[];
  nextPageToken?: string;
  /** The mailbox history id at the time of the response; use as the next cursor. */
  historyId: string;
}

/** google.rpc.ErrorInfo, as carried in error.details[]. */
export interface WireErrorInfo {
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo';
  reason: string;
  domain: string;
  metadata?: Record<string, string>;
}

/** The Google API JSON error envelope. */
export interface WireErrorResponse {
  error: {
    code: number;
    message: string;
    errors?: Array<{
      domain: string;
      reason: string;
      message: string;
      location?: string;
      locationType?: string;
    }>;
    status?: string;
    details?: Array<WireErrorInfo | Record<string, unknown>>;
  };
}

/** A fixture bundling the status line, headers and parsed body of one response. */
export interface WireResponseFixture<T> {
  status: number;
  headers: Record<string, string>;
  body: T;
}
