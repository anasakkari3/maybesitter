/**
 * «اختار ملف من Drive»: one file the person picks in Google's own picker, read
 * once into the proposal they already know how to review (CL6a, council item 3).
 *
 * ── Why `drive.file` and a picker ────────────────────────────────
 *
 * `drive.file` reaches only files the person opened with this app — in
 * practice, only what they pick in Google Picker. It is not a restricted scope
 * (no CASA assessment), and it makes "we read one document you chose" a
 * property of the grant rather than a promise about our code.
 *
 * ── The picker page, and the ticket that opens it ────────────────
 *
 * Picker is a web component: it needs a browser page holding an access token,
 * the owner's Picker API key and the project number. The page opens in the
 * system browser (the app's auth session), which carries no Firebase token, so
 * the app first mints a **ticket** through an authenticated route. The ticket
 * is `uid.random`; only SHA-256 of the random half is stored, it lives two
 * minutes, and the page redeems it exactly once in a transaction. The access
 * token therefore never passes through the app and never appears in a URL: it
 * is written into the one page load that redeemed the ticket, over TLS, and
 * the browser forgets the page when the session closes.
 *
 * ── The read ─────────────────────────────────────────────────────
 *
 * Metadata first (type and size, nothing else), then the bytes: a Google Doc
 * exported as plain text, or a PDF / `.txt` / `.md` as stored. Anything else is
 * refused by type before a byte of it is downloaded, and every download is
 * counted as it streams and stopped at the share channel's own per-file bound.
 * The bytes go to `proposeFromShare` as a file — the same document channel a
 * PDF shared from Files goes through — and are zeroed there whatever happens.
 * Nothing about the file is stored or logged; its name is never even fetched.
 */
import { createHash, randomBytes } from 'node:crypto';
import { GOOGLE_PICKER_TICKETS, docIdForKey, userSubDoc } from '../../storage/paths';
import {
  MAX_FILE_BYTES,
  proposeFromShare,
  type ShareProposalResult,
} from '../../services/share/shareIntakeService';
import {
  googleAccessToken,
  googleResourceFetch,
  getGoogleStatus,
  refusalForResponse,
  requireReadableFeature,
  GoogleConnectError,
} from './googleConnectService';
import {
  GOOGLE_PICKER_PAGE_PATH,
  GOOGLE_PICKER_RETURN_URL,
  resolveGoogleConfig,
} from './googleConfig';
import type { GoogleRuntime } from './googleRuntime';

export const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const PICKER_TICKET_TTL_MS = 2 * 60_000;

/** What Picker offers, and so what can ever be imported. */
export const DRIVE_IMPORTABLE_TYPES = Object.freeze({
  googleDoc: 'application/vnd.google-apps.document',
  pdf: 'application/pdf',
  text: 'text/plain',
  markdown: 'text/markdown',
} as const);

/** Drive file ids are URL-safe base64-ish tokens. Anything else is not one. */
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const TICKET = /^([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{43})$/;

interface StoredTicket {
  readonly version: 1;
  readonly createdAt: string;
  /** A Date, so Firestore's TTL policy on `expiresAt` can delete it. */
  readonly expiresAt: Date | string | { toDate(): Date };
}

function expiryMs(value: StoredTicket['expiresAt']): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') return (value as { toDate(): Date }).toDate().getTime();
  return Number.NaN;
}

function ticketPath(uid: string, secret: string): string {
  return userSubDoc(uid, GOOGLE_PICKER_TICKETS, docIdForKey(`picker-ticket:${secret}`));
}

export interface PickerTicket {
  readonly pickerUrl: string;
  readonly expiresAt: string;
  readonly returnUrl: string;
}

/** Mints the one-time ticket the picker page redeems. */
export async function beginDrivePick(uid: string, runtime: GoogleRuntime): Promise<PickerTicket> {
  const resolved = await resolveGoogleConfig({ env: runtime.env, secrets: runtime.secrets });
  if (!resolved.configured) throw new GoogleConnectError('provider_not_configured');
  if (!resolved.config.pickerApiKey || !resolved.config.appId) throw new GoogleConnectError('google_picker_unavailable');
  const status = await getGoogleStatus(uid, runtime);
  if (status.status === 'not_connected') throw new GoogleConnectError('google_not_connected');
  if (status.status === 'needs_reauth') throw new GoogleConnectError('google_reauth_required');
  if (!status.features.drive) throw new GoogleConnectError('google_feature_not_granted');

  const secret = (runtime.random ?? randomBytes)(32).toString('base64url');
  const now = runtime.now();
  const expiresAt = new Date(now.getTime() + PICKER_TICKET_TTL_MS);
  await runtime.storage.set<StoredTicket>(ticketPath(uid, secret), {
    version: 1,
    createdAt: now.toISOString(),
    expiresAt,
  });
  const url = new URL(GOOGLE_PICKER_PAGE_PATH, resolved.config.publicOrigin);
  url.searchParams.set('ticket', `${uid}.${secret}`);
  return { pickerUrl: url.toString(), expiresAt: expiresAt.toISOString(), returnUrl: GOOGLE_PICKER_RETURN_URL };
}

/** What the picker page needs. Held only for the one response that renders it. */
export interface PickerPageConfig {
  readonly accessToken: string;
  readonly apiKey: string;
  readonly appId: string;
  readonly returnUrl: string;
}

/**
 * Redeems a ticket, once. Null for anything that is not a live, unspent ticket
 * — malformed, unknown, expired or already used all look the same from
 * outside, and a spent ticket stays spent whatever happens after.
 */
export async function redeemDrivePickTicket(ticket: unknown, runtime: GoogleRuntime): Promise<PickerPageConfig | null> {
  if (typeof ticket !== 'string') return null;
  const match = TICKET.exec(ticket);
  if (!match) return null;
  const [, uid, secret] = match as unknown as [string, string, string];
  let path: string;
  try {
    path = ticketPath(uid, secret);
  } catch {
    return null;
  }
  const stored = await runtime.storage.runTransaction(async (tx) => {
    const value = await tx.get<StoredTicket>(path);
    if (value) tx.delete(path);
    return value ?? null;
  });
  if (!stored) return null;
  if (!(expiryMs(stored.expiresAt) > runtime.now().getTime())) return null;

  const resolved = await resolveGoogleConfig({ env: runtime.env, secrets: runtime.secrets });
  if (!resolved.configured || !resolved.config.pickerApiKey || !resolved.config.appId) return null;
  /*
   * ── This token carries every scope the grant holds (CL6a review m2) ──
   *
   * With `include_granted_scopes=true` there is one combined grant, so the
   * access token the page hands Picker can read Gmail too if Gmail is on —
   * not only `drive.file`. It is not narrowed, for two reasons:
   *
   *  - Google's documented refresh request (G1, "Refreshing an access token")
   *    takes `client_id`, `client_secret`, `grant_type` and `refresh_token`,
   *    and no `scope`. RFC 6749 §6 allows a narrower `scope` there, but
   *    Google does not document honouring it, and a narrowing we cannot rely
   *    on is not a control.
   *  - A token that carries only `drive.file` means a separate authorization
   *    without `include_granted_scopes` — a second consent screen on every
   *    pick, or a second OAuth client — for a page the person opens for a
   *    few seconds.
   *
   * What bounds it instead: the page is reachable once, by a two-minute,
   * single-use, digest-stored ticket; it is `no-store` and `no-referrer`; its
   * only scripts are its own (by nonce) and Google's loader; the token lives
   * in an inert JSON block the page empties as soon as it has read it; and it
   * expires within the hour like every access token. The Picker API key on
   * the page is public by design and restricted to the Picker API.
   */
  let accessToken: string;
  try {
    accessToken = await googleAccessToken(uid, 'drive', runtime);
  } catch {
    return null;
  }
  return {
    accessToken,
    apiKey: resolved.config.pickerApiKey,
    appId: resolved.config.appId,
    returnUrl: GOOGLE_PICKER_RETURN_URL,
  };
}

/** Reads a body, counting as it streams, and stops one chunk past `limit`. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleConnectError('google_file_too_large');
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      for (const chunk of chunks) chunk.fill(0);
      throw new GoogleConnectError('google_file_too_large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
    chunk.fill(0);
  }
  return out;
}

export interface DriveImportInput {
  readonly fileId: unknown;
  readonly timezone?: unknown;
  readonly referenceTime?: unknown;
}

export class DriveImportInputError extends Error {
  constructor() {
    super('fileId must be a Google Drive file id');
    this.name = 'DriveImportInputError';
  }
}

/** Reads the one picked file into a proposal. */
export async function importDriveFile(
  uid: string,
  input: DriveImportInput,
  runtime: GoogleRuntime,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ShareProposalResult> {
  if (typeof input.fileId !== 'string' || !FILE_ID.test(input.fileId)) throw new DriveImportInputError();
  const fileId = input.fileId;
  await requireReadableFeature(uid, 'drive', runtime);
  const base = `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}`;

  // Type and size only. Not the name: the name is content, and nothing here needs it.
  const meta = await googleResourceFetch(uid, 'drive', runtime, `${base}?fields=mimeType,size&supportsAllDrives=true`);
  if (!meta.ok) throw refusalForResponse(meta);
  let described: { mimeType?: unknown; size?: unknown };
  try {
    described = (await meta.json()) as { mimeType?: unknown; size?: unknown };
  } catch {
    throw new GoogleConnectError('google_unavailable');
  }
  const mimeType = typeof described.mimeType === 'string' ? described.mimeType : '';
  const size = typeof described.size === 'string' ? Number.parseInt(described.size, 10) : Number.NaN;
  if (Number.isFinite(size) && size > MAX_FILE_BYTES) throw new GoogleConnectError('google_file_too_large');

  let url: string;
  let declaredType: string;
  if (mimeType === DRIVE_IMPORTABLE_TYPES.googleDoc) {
    url = `${base}/export?mimeType=${encodeURIComponent('text/plain')}`;
    declaredType = 'text/plain';
  } else if (mimeType === DRIVE_IMPORTABLE_TYPES.pdf) {
    url = `${base}?alt=media&supportsAllDrives=true`;
    declaredType = 'application/pdf';
  } else if (mimeType === DRIVE_IMPORTABLE_TYPES.text || mimeType === DRIVE_IMPORTABLE_TYPES.markdown) {
    url = `${base}?alt=media&supportsAllDrives=true`;
    declaredType = 'text/plain';
  } else {
    throw new GoogleConnectError('google_file_unsupported');
  }

  const content = await googleResourceFetch(uid, 'drive', runtime, url, { timeoutMs: 30_000 });
  if (!content.ok) throw refusalForResponse(content);
  const bytes = await readCapped(content, MAX_FILE_BYTES);
  if (bytes.byteLength === 0) {
    throw new GoogleConnectError('google_file_unsupported');
  }

  return proposeFromShare(
    {
      files: [{ bytes, declaredType, fileName: null }],
      timezone: input.timezone,
      referenceTime: input.referenceTime,
    },
    {
      uid,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(runtime.shareModel ? { generateStructured: runtime.shareModel } : {}),
      now: runtime.now(),
    },
  );
}

/** For tests: the stored form of a ticket, which must never be the ticket. */
export function pickerTicketDigest(secret: string): string {
  return createHash('sha256').update(`picker-ticket:${secret}`).digest('hex');
}
