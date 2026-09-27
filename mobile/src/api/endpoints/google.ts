import { apiRequest, UPLOAD_TIMEOUT_MS } from '../client';
import {
  googleCalendarBlocksSchema,
  googleCalendarSyncedSchema,
  googleConnectStartedSchema,
  googleDisconnectedSchema,
  googlePickerTicketSchema,
  googleStatusResponseSchema,
  type GoogleFeature,
} from '../schemas/google';
import { shareProposalSchema, type ShareProposal } from '../schemas/share';

/**
 * The Google calls (CL6a). One connection per account; every route derives
 * the account from the bearer, so nothing here names one.
 *
 * None of these is retried by a wrapper: a connect mints a state, a callback
 * spends one, a scan spends one of the day's shares, and a replay the person
 * did not ask for is the thing #157 forbids.
 */

export function getGoogleStatus() {
  return apiRequest('GET', '/api/mobile/integrations/google', { schema: googleStatusResponseSchema });
}

export function startGoogleConnect(feature: GoogleFeature) {
  return apiRequest('POST', '/api/mobile/integrations/google/connect', {
    body: { feature },
    schema: googleConnectStartedSchema,
  });
}

/**
 * What the auth session carried back: `code` and `state`, or Google's closed
 * `error`. Posted signed in — the server binds the grant to this bearer's
 * account, never to anything in the body.
 */
export function completeGoogleConnect(returned: { code: string; state: string } | { error: string }) {
  return apiRequest('POST', '/api/mobile/integrations/google/callback', {
    body: returned,
    schema: googleStatusResponseSchema,
  });
}

export function disconnectGoogle() {
  return apiRequest('POST', '/api/mobile/integrations/google/disconnect', { schema: googleDisconnectedSchema });
}

/** Reads the next fourteen days of Google busy time into the account. */
export function syncGoogleCalendar() {
  return apiRequest('POST', '/api/mobile/integrations/google/calendar', { schema: googleCalendarSyncedSchema });
}

export function listGoogleBusy() {
  return apiRequest('GET', '/api/mobile/integrations/google/calendar', { schema: googleCalendarBlocksSchema });
}

/** «جيب التزامات من إيميلي»: the last seven days of Primary, twenty messages at most. */
export function scanGmail(input: { timezone: string; referenceTime?: string }): Promise<ShareProposal> {
  return apiRequest('POST', '/api/mobile/integrations/google/gmail/scan', {
    body: { timezone: input.timezone, referenceTime: input.referenceTime ?? new Date().toISOString() },
    schema: shareProposalSchema,
    // Twenty messages fetched and read by the model: a share's time, not a lookup's.
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

export function beginDrivePick() {
  return apiRequest('POST', '/api/mobile/integrations/google/drive/picker', { schema: googlePickerTicketSchema });
}

/** The one file the person picked, read into a proposal. */
export function importDriveFile(input: { fileId: string; timezone: string; referenceTime?: string }): Promise<ShareProposal> {
  return apiRequest('POST', '/api/mobile/integrations/google/drive/import', {
    body: { fileId: input.fileId, timezone: input.timezone, referenceTime: input.referenceTime ?? new Date().toISOString() },
    schema: shareProposalSchema,
    // A file downloaded from Drive and read by the model, like a shared PDF.
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}
