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
 * email share channel one message at a time, then through the capture pipeline
 * once — `proposeFromMailbox`. The answer is a capture proposal; nothing is
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
  await requireReadableFeature(uid, 'gmail', runtime);
  const transport = createGmailTransport({
    accessToken: () => googleAccessToken(uid, 'gmail', runtime),
    // D10's one reaction to a 401 on a token the record still calls active.
    reauth: () => googleAccessToken(uid, 'gmail', runtime, { forceRefresh: true }),
    fetchImpl: runtime.fetchImpl,
  });

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

  return proposeFromMailbox({
    messages: messages.map((message) => ({
      subject: message.subject,
      receivedAt: message.receivedAt,
      text: message.text,
    })),
    timezone: input.timezone,
    referenceTime: input.referenceTime,
  }, { uid, ...(options.signal ? { signal: options.signal } : {}), now: runtime.now() });
}
