/**
 * «جيب التزامات من إيميلي»: a bounded read of somebody's own recent mail into
 * the proposal they already know how to review (CL6a, council item 2).
 *
 * ── The bound is the design ──────────────────────────────────────
 *
 * The last seven days, the Primary category, at most twenty messages, once,
 * because the person pressed a button. No cursor is kept, nothing runs in the
 * background, and nothing is read that the person did not just ask for — which
 * is what keeps this on the right side of the strategy's "no broad message
 * ingestion" line. The query is a constant: nothing a client sends reaches it.
 *
 * ── Where the mail goes ──────────────────────────────────────────
 *
 * Through the production Gmail transport (the same HTTP path, retries, pacing,
 * 256 KiB-per-message clamp and redaction as Phase B's sync), then through the
 * email channel's checks per message and at most three model calls for all of
 * them, then through the capture pipeline once — `proposeFromMailbox`. The
 * envelope's `metrics` say how many messages were found, read and not read. The answer is a capture proposal; nothing is
 * saved until the person confirms it.
 *
 * Bodies are never stored and never logged. They live in this request's memory
 * between the transport and the channel, and the only piece of any message
 * that leaves the server is the channel's own ≤140-character evidence excerpt,
 * in the response, to the phone whose mail it is.
 */
import { createGmailTransport } from '../gmail/production/gmailTransport';
import { GmailProviderError } from '../gmail/adapter';
import { proposeFromMailbox, type ShareProposalResult } from '../../services/share/shareIntakeService';
import { googleAccessToken, GoogleConnectError, markGoogleNeedsReauth, requireReadableFeature } from './googleConnectService';
import type { GoogleRuntime } from './googleRuntime';

/** Primary only, last seven days. A constant: nothing a client sends reaches it. */
export const GMAIL_SCAN_QUERY = 'category:primary newer_than:7d';
export const GMAIL_SCAN_MAX_MESSAGES = 20;

/**
 * The whole scan answers within this (CL6a round 2, N5).
 *
 * The app gives up on the request at 60 s (`UPLOAD_TIMEOUT_MS`). Three model
 * calls at the provider's 45 s each, plus Gmail, plus the capture pipeline,
 * could take longer than that, and the person would then see a network error
 * while the server kept reading and spending. So the scan keeps its own clock,
 * below the app's.
 */
export const GMAIL_SCAN_DEADLINE_MS = 50_000;
/**
 * Kept back from the deadline for what runs after the mail is read: the
 * capture pipeline's own model call (8 s) and the answer. The mailbox read
 * stops starting model calls when only this much is left, and a call that
 * is running is cut there.
 */
export const GMAIL_SCAN_CAPTURE_RESERVE_MS = 10_000;

export interface GmailScanInput {
  readonly timezone?: unknown;
  readonly referenceTime?: unknown;
}

export async function scanRecentGmail(
  uid: string,
  input: GmailScanInput,
  runtime: GoogleRuntime,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ShareProposalResult> {
  // From the moment the request is being served, not from the first model call.
  const deadline = {
    at: runtime.now().getTime() + GMAIL_SCAN_DEADLINE_MS - GMAIL_SCAN_CAPTURE_RESERVE_MS,
    now: () => runtime.now().getTime(),
  };
  await requireReadableFeature(uid, 'gmail', runtime);
  const transport = createGmailTransport({
    accessToken: () => googleAccessToken(uid, 'gmail', runtime),
    // D10's one reaction to a 401 on a token the record still calls active.
    reauth: () => googleAccessToken(uid, 'gmail', runtime, { forceRefresh: true }),
    fetchImpl: runtime.fetchImpl,
  });

  // The day's share is claimed inside `proposeFromMailbox` before this runs,
  // so a quota refusal has read no mail.
  const readMessages = async () => {
    let messages;
    try {
      messages = await transport.listRecentMessages({ query: GMAIL_SCAN_QUERY, maxResults: GMAIL_SCAN_MAX_MESSAGES });
    } catch (error) {
      if (error instanceof GoogleConnectError) throw error;
      if (error instanceof GmailProviderError) {
        // The transport already refreshed once and retried (`reauth`), so a
        // second 401 is a grant that is gone.
        if (error.status === 401) throw await markGoogleNeedsReauth(uid, runtime);
        if (error.status === 403) throw new GoogleConnectError('google_permission_not_granted');
      }
      throw new GoogleConnectError('google_unavailable');
    }
    return messages.map((message) => ({
      subject: message.subject,
      receivedAt: message.receivedAt,
      text: message.text,
    }));
  };

  return proposeFromMailbox({
    readMessages,
    timezone: input.timezone,
    referenceTime: input.referenceTime,
    deadline,
  }, {
    uid,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(runtime.shareModel ? { generateStructured: runtime.shareModel } : {}),
    now: runtime.now(),
  });
}
