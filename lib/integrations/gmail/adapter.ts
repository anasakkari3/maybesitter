import { createHash } from 'node:crypto';
import type {
  IntegrationCapability,
  IntegrationConnectionRecord,
} from '../../../src/contracts/v1/integrationConnectionContracts';
import {
  buildProviderDisconnectRequest,
  classifyProviderFailure,
  isProviderTransportFailure,
  planProviderSync,
  type ProviderDisconnectRequest,
  type ProviderFailure,
  type ProviderOAuthTokenMetadata,
} from '../providers/providerRuntime';
import {
  untrustedExternalContentBoundary,
  type ExternalInstructionSignal,
} from '../providers/untrustedExternalContent';

export const GMAIL_PROVIDER = 'google' as const;

export const GMAIL_SCOPES = Object.freeze({
  read: 'https://www.googleapis.com/auth/gmail.readonly',
  draft: 'https://www.googleapis.com/auth/gmail.compose',
  send: 'https://www.googleapis.com/auth/gmail.send',
} as const);

export interface GmailMessagePayload {
  readonly id: string;
  readonly threadId: string | null;
  readonly historyId: string;
  readonly receivedAt: string;
  readonly from: string | null;
  readonly subject: string | null;
  readonly text: string;
}

export interface GmailUntrustedContext {
  readonly trust: 'untrusted_external_content';
  readonly contentClass: 'email';
  readonly allowedEffect: 'interpret_or_propose_only';
  readonly privilegedActionAllowed: false;
  readonly provider: typeof GMAIL_PROVIDER;
  readonly connectionId: string;
  readonly externalId: string;
  readonly threadId: string | null;
  readonly historyId: string;
  readonly receivedAt: string;
  readonly from: string | null;
  readonly subject: string | null;
  readonly text: string;
  readonly dedupeKey: string;
  readonly injectionSignals: readonly ExternalInstructionSignal[];
  readonly provenance: {
    readonly source: 'gmail';
    readonly fetchedAt: string;
  };
}

export interface GmailHistoryPage {
  readonly historyId: string;
  readonly messages: readonly GmailMessagePayload[];
  readonly nextPageToken: string | null;
}

export interface GmailHistoryRequest {
  readonly connectionId: string;
  readonly startHistoryId: string | null;
  readonly pageToken: string | null;
  readonly maxResults: number;
}

export interface GmailApiPort {
  listHistory(request: GmailHistoryRequest): Promise<GmailHistoryPage>;
}

export interface GmailSyncLogger {
  log(event: {
    readonly provider: 'gmail';
    readonly state: GmailSyncResult['state'];
    readonly itemCount: number;
    readonly pageCount: number;
    readonly errorCode: string | null;
  }): void;
}

export interface GmailSyncInput {
  readonly connection: IntegrationConnectionRecord;
  readonly token: ProviderOAuthTokenMetadata | null;
  readonly now: string;
  readonly maxPages?: number;
  readonly pageSize?: number;
  readonly logger?: GmailSyncLogger;
}

export interface GmailSyncResult {
  readonly state: 'complete' | 'partial' | 'blocked' | 'cursor_reset_required' | 'error';
  readonly items: readonly GmailUntrustedContext[];
  readonly nextHistoryId: string | null;
  readonly pagesRead: number;
  readonly failure: ProviderFailure | null;
  readonly blockReason: string | null;
}

export class GmailProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly staleCursor = false,
    readonly malformedResponse = false,
  ) {
    super(message);
  }
}

export function gmailScopesForCapabilities(
  capabilities: readonly IntegrationCapability[],
): readonly string[] {
  const scopes: string[] = [];
  if (capabilities.includes('mail_read')) scopes.push(GMAIL_SCOPES.read);
  if (capabilities.includes('mail_draft')) scopes.push(GMAIL_SCOPES.draft);
  if (capabilities.includes('mail_send')) scopes.push(GMAIL_SCOPES.send);
  return Object.freeze(Array.from(new Set(scopes)).sort());
}

export function normalizeGmailMessage(
  payload: GmailMessagePayload,
  connectionId: string,
  fetchedAt: string,
): GmailUntrustedContext {
  if (!payload.id.trim() || !payload.historyId.trim() || !Number.isFinite(Date.parse(payload.receivedAt))) {
    throw new GmailProviderError('Malformed Gmail message', null, false, true);
  }
  const combined = [payload.subject ?? '', payload.text].join('\n');
  const trustBoundary = untrustedExternalContentBoundary(combined);
  return {
    ...trustBoundary,
    contentClass: 'email',
    provider: GMAIL_PROVIDER,
    connectionId,
    externalId: payload.id,
    threadId: payload.threadId,
    historyId: payload.historyId,
    receivedAt: payload.receivedAt,
    from: payload.from,
    subject: payload.subject,
    text: payload.text,
    dedupeKey: createHash('sha256').update(`gmail\0${connectionId}\0${payload.id}`).digest('hex'),
    provenance: { source: 'gmail', fetchedAt },
  };
}

export async function runGmailIncrementalSync(
  port: GmailApiPort,
  input: GmailSyncInput,
): Promise<GmailSyncResult> {
  const plan = planProviderSync(input.connection, {
    provider: GMAIL_PROVIDER,
    requiredCapabilities: ['mail_read'],
    token: input.token,
  }, input.now);
  if (!plan.shouldSync) {
    return finish(input, {
      state: 'blocked', items: [], nextHistoryId: null, pagesRead: 0,
      failure: null, blockReason: plan.reason,
    });
  }

  const maxPages = Math.max(1, Math.min(input.maxPages ?? 10, 50));
  const pageSize = Math.max(1, Math.min(input.pageSize ?? 100, 500));
  const byKey = new Map<string, GmailUntrustedContext>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | null = null;
  let nextHistoryId = plan.cursor;
  let pagesRead = 0;

  try {
    while (pagesRead < maxPages) {
      const page = await port.listHistory({
        connectionId: input.connection.connectionId,
        startHistoryId: plan.cursor,
        pageToken,
        maxResults: pageSize,
      });
      pagesRead += 1;
      if (!page.historyId.trim()) throw new GmailProviderError('Missing Gmail history id', null, false, true);
      nextHistoryId = page.historyId;
      for (const message of page.messages) {
        const normalized = normalizeGmailMessage(message, input.connection.connectionId, input.now);
        byKey.set(normalized.dedupeKey, normalized);
      }
      if (!page.nextPageToken) {
        return finish(input, {
          state: 'complete', items: Array.from(byKey.values()), nextHistoryId,
          pagesRead, failure: null, blockReason: null,
        });
      }
      if (seenPageTokens.has(page.nextPageToken)) {
        throw new GmailProviderError('Repeated Gmail page token', null, false, true);
      }
      seenPageTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    }

    return finish(input, {
      state: 'partial', items: Array.from(byKey.values()), nextHistoryId: plan.cursor,
      pagesRead, failure: null, blockReason: 'page_limit',
    });
  } catch (error) {
    const providerError = error instanceof GmailProviderError ? error : null;
    // A throw that is not a `GmailProviderError` is not evidence of a bad
    // payload — a timeout or a reset socket is not a response at all. Declaring
    // it `malformedResponse` accused the provider of breaking its contract and
    // made the textbook retryable failure non-retryable. Classify what it is:
    // a transport failure if it looks like one, otherwise `unknown`.
    const failure = classifyProviderFailure({
      httpStatus: providerError?.status,
      staleCursor: providerError?.staleCursor,
      malformedResponse: providerError?.malformedResponse ?? false,
      transportFailure: providerError === null && isProviderTransportFailure(error),
    });
    const state = failure.kind === 'stale_cursor' && byKey.size === 0
      ? 'cursor_reset_required'
      : byKey.size > 0 ? 'partial' : 'error';
    return finish(input, {
      state,
      items: Array.from(byKey.values()),
      nextHistoryId: plan.cursor,
      pagesRead,
      failure,
      blockReason: null,
    });
  }
}

export function buildGmailDisconnectRequest(
  connectionId: string,
  requestedAt: string,
): ProviderDisconnectRequest {
  return buildProviderDisconnectRequest(GMAIL_PROVIDER, connectionId, requestedAt);
}

export const GMAIL_DATA_POLICY = Object.freeze({
  mailboxMirrorAllowed: false,
  externalContentTrusted: false,
  contentMayExecuteActions: false,
  persistOnlyDerivedProposalAndProvenance: true,
  includeConnectionInAccountExport: true,
  deleteConnectionAndDerivedContextOnAccountDeletion: true,
});

function finish(input: GmailSyncInput, result: GmailSyncResult): GmailSyncResult {
  input.logger?.log({
    provider: 'gmail',
    state: result.state,
    itemCount: result.items.length,
    pageCount: result.pagesRead,
    errorCode: result.failure?.safeErrorCode ?? null,
  });
  return result;
}
