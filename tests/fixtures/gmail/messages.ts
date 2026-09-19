/**
 * users.messages.list and users.messages.get fixtures.
 *
 * Sources:
 *  - list    https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
 *  - get     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
 *  - Message https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
 *  - Format  https://developers.google.com/workspace/gmail/api/reference/rest/v1/Format
 *
 * maxResults: default 100, maximum 500 (documented on list).
 * Bodies are base64url (RFC 4648 §5: '-' and '_', padding stripped). The
 * strings below are real encodings of the plaintext in BODY_TEXT_PLAIN /
 * BODY_TEXT_HTML, so a decoder test is a real round-trip, not a tautology.
 */
import type {
  WireMessage,
  WireMessagesListResponse,
  WireResponseFixture,
} from './wireTypes';

export const MSG_ID_1 = '19a1f2c3d4e5f601';
export const MSG_ID_2 = '19a1f2c3d4e5f602';
export const MSG_ID_3 = '19a1f2c3d4e5f603';
export const THREAD_ID_1 = '19a1f2c3d4e5f600';

/** Page-2 cursor. Opaque to the client; only echoed back as `pageToken`. */
export const MESSAGES_PAGE_TOKEN = '09876543210987654321';

/** Decoded form of MESSAGE_FULL's text/plain part. */
export const BODY_TEXT_PLAIN =
  'Hi,\r\n\r\nSwimming practice moved to Thursday 17:00 at the Herzliya pool.\r\nPlease confirm.\r\n\r\n-- Coach Dana\r\n';
/** Decoded form of MESSAGE_FULL's text/html part. */
export const BODY_TEXT_HTML =
  '<div dir="ltr"><p>Hi,</p><p>Swimming practice moved to <b>Thursday 17:00</b> at the Herzliya pool.</p><p>Please confirm.</p><p>-- Coach Dana</p></div>';

const B64U_PLAIN =
  'SGksDQoNClN3aW1taW5nIHByYWN0aWNlIG1vdmVkIHRvIFRodXJzZGF5IDE3OjAwIGF0IHRoZSBIZXJ6bGl5YSBwb29sLg0KUGxlYXNlIGNvbmZpcm0uDQoNCi0tIENvYWNoIERhbmENCg';
const B64U_HTML =
  'PGRpdiBkaXI9Imx0ciI-PHA-SGksPC9wPjxwPlN3aW1taW5nIHByYWN0aWNlIG1vdmVkIHRvIDxiPlRodXJzZGF5IDE3OjAwPC9iPiBhdCB0aGUgSGVyemxpeWEgcG9vbC48L3A-PHA-UGxlYXNlIGNvbmZpcm0uPC9wPjxwPi0tIENvYWNoIERhbmE8L3A-PC9kaXY-';
const B64U_RAW =
  'TUlNRS1WZXJzaW9uOiAxLjANCkRhdGU6IFRodSwgMTcgU2VwIDIwMjYgMDk6MTQ6MDIgKzAzMDANCk1lc3NhZ2UtSUQ6IDxDQStmaXh0dXJlMDAwMUBtYWlsLmdtYWlsLmNvbT4NClN1YmplY3Q6IFByYWN0aWNlIG1vdmVkIHRvIFRodXJzZGF5DQpGcm9tOiBDb2FjaCBEYW5hIDxkYW5hQGV4YW1wbGUub3JnPg0KVG86IE93bmVyIDxvd25lckBleGFtcGxlLmNvbT4NCkNvbnRlbnQtVHlwZTogdGV4dC9wbGFpbjsgY2hhcnNldD0iVVRGLTgiDQoNCkhpLA0KDQpTd2ltbWluZyBwcmFjdGljZSBtb3ZlZCB0byBUaHVyc2RheSAxNzowMCBhdCB0aGUgSGVyemxpeWEgcG9vbC4NClBsZWFzZSBjb25maXJtLg0KDQotLSBDb2FjaCBEYW5hDQo';

/* ------------------------------------------------------------------ list -- */

/** GET /users/me/messages?maxResults=2 -> 200, first of two pages. */
export const MESSAGES_LIST_PAGE_1: WireResponseFixture<WireMessagesListResponse> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: {
    messages: [
      { id: MSG_ID_1, threadId: THREAD_ID_1 },
      { id: MSG_ID_2, threadId: THREAD_ID_1 },
    ],
    nextPageToken: MESSAGES_PAGE_TOKEN,
    resultSizeEstimate: 3,
  },
};

/** Same call with pageToken=MESSAGES_PAGE_TOKEN -> 200, last page (no nextPageToken). */
export const MESSAGES_LIST_PAGE_2: WireResponseFixture<WireMessagesListResponse> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: {
    messages: [{ id: MSG_ID_3, threadId: '19a1f2c3d4e5f5aa' }],
    resultSizeEstimate: 3,
  },
};

/**
 * Empty result. Note the `messages` key is ABSENT, not `[]` — Google omits
 * empty repeated fields in JSON. A client that does `res.messages.length`
 * throws here, which is the point of this fixture.
 */
export const MESSAGES_LIST_EMPTY: WireResponseFixture<WireMessagesListResponse> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: { resultSizeEstimate: 0 },
};

/* ------------------------------------------------------------------- get -- */

/** format=MINIMAL: id and labels only. No headers, no body, no payload parts. */
export const MESSAGE_MINIMAL: WireResponseFixture<WireMessage> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: {
    id: MSG_ID_1,
    threadId: THREAD_ID_1,
    labelIds: ['UNREAD', 'CATEGORY_PERSONAL', 'INBOX'],
    snippet: 'Swimming practice moved to Thursday 17:00 at the Herzliya pool.',
    historyId: '2418871',
    internalDate: '1789632842000',
    sizeEstimate: 4219,
  },
};

/**
 * format=METADATA with metadataHeaders=From,To,Subject,Date.
 * payload is present but carries headers only — body.data is absent.
 * This is the narrowest format that still yields sender/subject/date, and it
 * is the only get format usable under the gmail.metadata scope.
 */
export const MESSAGE_METADATA: WireResponseFixture<WireMessage> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: {
    id: MSG_ID_1,
    threadId: THREAD_ID_1,
    labelIds: ['UNREAD', 'CATEGORY_PERSONAL', 'INBOX'],
    snippet: 'Swimming practice moved to Thursday 17:00 at the Herzliya pool.',
    historyId: '2418871',
    internalDate: '1789632842000',
    sizeEstimate: 4219,
    payload: {
      partId: '',
      mimeType: 'multipart/alternative',
      filename: '',
      headers: [
        { name: 'Date', value: 'Thu, 17 Sep 2026 09:14:02 +0300' },
        { name: 'From', value: 'Coach Dana <dana@example.org>' },
        { name: 'To', value: 'Owner <owner@example.com>' },
        { name: 'Subject', value: 'Practice moved to Thursday' },
      ],
      body: { size: 0 },
    },
  },
};

/**
 * format=FULL: parsed payload, body bytes base64url in body.data, `raw` absent.
 * Multipart, so the text lives in payload.parts[*].body.data and payload.body
 * is an empty container — the shape a naive client gets wrong.
 */
export const MESSAGE_FULL: WireResponseFixture<WireMessage> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: {
    id: MSG_ID_1,
    threadId: THREAD_ID_1,
    labelIds: ['UNREAD', 'CATEGORY_PERSONAL', 'INBOX'],
    snippet: 'Swimming practice moved to Thursday 17:00 at the Herzliya pool.',
    historyId: '2418871',
    internalDate: '1789632842000',
    sizeEstimate: 4219,
    payload: {
      partId: '',
      mimeType: 'multipart/alternative',
      filename: '',
      headers: [
        { name: 'MIME-Version', value: '1.0' },
        { name: 'Date', value: 'Thu, 17 Sep 2026 09:14:02 +0300' },
        { name: 'Message-ID', value: '<CA+fixture0001@mail.gmail.com>' },
        { name: 'Subject', value: 'Practice moved to Thursday' },
        { name: 'From', value: 'Coach Dana <dana@example.org>' },
        { name: 'To', value: 'Owner <owner@example.com>' },
        { name: 'Content-Type', value: 'multipart/alternative; boundary="000000000000fixture01"' },
      ],
      body: { size: 0 },
      parts: [
        {
          partId: '0',
          mimeType: 'text/plain',
          filename: '',
          headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
          body: { size: 106, data: B64U_PLAIN },
        },
        {
          partId: '1',
          mimeType: 'text/html',
          filename: '',
          headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }],
          body: { size: 150, data: B64U_HTML },
        },
      ],
    },
  },
};

/**
 * format=FULL with an attachment: the attachment part has a filename, a size
 * and an `attachmentId`, and NO `data` — fetching it is a separate
 * users.messages.attachments.get call that Phase B must NOT make.
 */
export const MESSAGE_FULL_WITH_ATTACHMENT: WireResponseFixture<WireMessage> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: {
    id: MSG_ID_2,
    threadId: THREAD_ID_1,
    labelIds: ['INBOX'],
    snippet: 'Signed permission slip attached.',
    historyId: '2418879',
    internalDate: '1789636442000',
    sizeEstimate: 91733,
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      filename: '',
      headers: [
        { name: 'Subject', value: 'Permission slip' },
        { name: 'From', value: 'Coach Dana <dana@example.org>' },
        { name: 'To', value: 'Owner <owner@example.com>' },
        { name: 'Date', value: 'Thu, 17 Sep 2026 10:14:02 +0300' },
      ],
      body: { size: 0 },
      parts: [
        {
          partId: '0',
          mimeType: 'text/plain',
          filename: '',
          headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
          body: { size: 106, data: B64U_PLAIN },
        },
        {
          partId: '1',
          mimeType: 'application/pdf',
          filename: 'permission-slip.pdf',
          headers: [
            { name: 'Content-Type', value: 'application/pdf; name="permission-slip.pdf"' },
            { name: 'Content-Disposition', value: 'attachment; filename="permission-slip.pdf"' },
          ],
          body: {
            attachmentId:
              'ANGjdJ_fixture_attachment_token_0001_do_not_fetch',
            size: 87442,
          },
        },
      ],
    },
  },
};

/** format=RAW: whole RFC 2822 message base64url in `raw`; `payload` absent. */
export const MESSAGE_RAW: WireResponseFixture<WireMessage> = {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: {
    id: MSG_ID_1,
    threadId: THREAD_ID_1,
    labelIds: ['UNREAD', 'CATEGORY_PERSONAL', 'INBOX'],
    snippet: 'Swimming practice moved to Thursday 17:00 at the Herzliya pool.',
    historyId: '2418871',
    internalDate: '1789632842000',
    sizeEstimate: 4219,
    raw: B64U_RAW,
  },
};
