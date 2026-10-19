import { apiRequest } from '../client';
import { calendarBusyDeletedSchema, calendarBusyStoredSchema } from '../schemas/calendar';
import {
  addedPageSchema,
  addedRemovedSchema,
  busyIntentSchema,
  calendarChoiceEnrolSchema,
  calendarChoiceProbeSchema,
  emailScanOverviewSchema,
  emailScanPostSchema,
  m5aCapabilitiesSchema,
  phoneSourcesSchema,
  sourceRegisteredSchema,
  type AddedPage,
  type BusyIntent,
  type CalendarChoiceProbe,
  type EmailScanOverview,
  type M5aCapabilities,
} from '../schemas/m5a';
import type { CalendarBusyUpload } from './calendar';

/**
 * M5a's calls (PLAN-M5a Wire). Every one takes `asUid`: a request started for
 * one account is never sent as another (M5A-R53-002).
 *
 * The source secret travels only in `X-MaybeSitter-Source-Secret`, never in a
 * query or a body, and nothing here logs it.
 */
type Bound = { asUid?: string };
const bound = (options: Bound) => (options.asUid !== undefined ? { asUid: options.asUid } : {});

export const SOURCE_SECRET_HEADER = 'X-MaybeSitter-Source-Secret';
const secretHeader = (secret: string) => ({ headers: { [SOURCE_SECRET_HEADER]: secret } });

export function getM5aCapabilities(options: Bound = {}): Promise<M5aCapabilities> {
  return apiRequest('GET', '/api/mobile/capabilities/m5a', { schema: m5aCapabilitiesSchema, ...bound(options) });
}

/* ── calendar choice ─────────────────────────────────────────────────── */

/** Starts (or resumes) the account's enrolment; only `active` is done (M5A-R9-004). */
export function enrolCalendarChoice(options: Bound = {}) {
  return apiRequest('POST', '/api/mobile/calendar/choice', { body: {}, schema: calendarChoiceEnrolSchema, ...bound(options) });
}

/** The always-available probe: enrolment, and this phone's source status when it names one. */
export function probeCalendarChoice(sourceId: string | null, options: Bound = {}): Promise<CalendarChoiceProbe> {
  return apiRequest('GET', '/api/mobile/calendar/choice', {
    ...(sourceId ? { query: { sourceId } } : {}),
    schema: calendarChoiceProbeSchema,
    ...bound(options),
  });
}

export interface SourceCredential {
  sourceInstallationId: string;
  sourceSecret: string;
  registrationId: string;
}

export function registerBusySource(credential: SourceCredential, options: Bound = {}) {
  return apiRequest('POST', '/api/mobile/calendar/busy/register', {
    body: {
      sourceInstallationId: credential.sourceInstallationId,
      sourceSecret: credential.sourceSecret,
      registrationId: credential.registrationId,
    },
    schema: sourceRegisteredSchema,
    ...bound(options),
  });
}

export interface BusyIntentInput {
  sourceId: string;
  intentId: string;
  operation: 'upload' | 'clear';
  selectionDigest: string;
}

/** The server hears about a selection before the phone reads it; it mints the epoch (M5A-R52-001). */
export function postBusyIntent(input: BusyIntentInput, secret: string, options: Bound = {}): Promise<BusyIntent> {
  return apiRequest('POST', '/api/mobile/calendar/busy/intent', {
    body: { ...input, choiceVersion: 1 },
    schema: busyIntentSchema,
    ...secretHeader(secret),
    ...bound(options),
  });
}

export interface BusyContinuation {
  opId: string;
  epoch: number;
}

/** An upload that continues its intent's operation (same `opId`, same epoch). */
export function postCalendarBusyM5(
  upload: CalendarBusyUpload,
  continuation: BusyContinuation,
  secret: string,
  options: Bound = {},
) {
  return apiRequest('POST', '/api/mobile/calendar/busy', {
    body: {
      ...upload,
      opId: continuation.opId,
      epoch: continuation.epoch,
      selectionEpoch: continuation.epoch,
      choiceVersion: 1,
    },
    schema: calendarBusyStoredSchema,
    ...secretHeader(secret),
    ...bound(options),
  });
}

/** A clear that continues its intent's `clear` operation. Clearing is not removing: no `revoke`. */
export function clearCalendarBusyM5(sourceId: string, continuation: BusyContinuation, secret: string, options: Bound = {}) {
  return apiRequest('DELETE', '/api/mobile/calendar/busy', {
    query: { sourceId, opId: continuation.opId, epoch: continuation.epoch },
    schema: calendarBusyDeletedSchema,
    ...secretHeader(secret),
    ...bound(options),
  });
}

export function getPhoneSources(options: Bound = {}) {
  return apiRequest('GET', '/api/mobile/calendar/busy/sources', { schema: phoneSourcesSchema, ...bound(options) });
}

/** «امسح» on another phone: retires it permanently (M5A-R58-002). */
export function revokePhoneSource(sourceId: string, options: Bound = {}) {
  return apiRequest('DELETE', '/api/mobile/calendar/busy', {
    query: { sourceId, revoke: 1 },
    schema: calendarBusyDeletedSchema,
    ...bound(options),
  });
}

/* ── the email scan ──────────────────────────────────────────────────── */

export function getEmailScanOverview(options: Bound = {}): Promise<EmailScanOverview> {
  return apiRequest('GET', '/api/mobile/intelligence/sources/gmail/scan', { schema: emailScanOverviewSchema, ...bound(options) });
}

export type EmailScanRequest =
  | { intent: 'new'; timezone: string; origin?: 'backfill' }
  | { intent: 'resume'; expectedScanId: string };

/** The versioned scan (R2.3): a new seven-day window, or resume of the one named. */
export function postEmailScan(request: EmailScanRequest, options: Bound = {}) {
  return apiRequest('POST', '/api/mobile/intelligence/sources/gmail/scan', {
    body: { m5: true, ...request },
    schema: emailScanPostSchema,
    ...bound(options),
  });
}

/* ── added from email ────────────────────────────────────────────────── */

export const ADDED_PAGE_SIZE = 20;

export function getAddedPage(cursor: string | null, options: Bound = {}): Promise<AddedPage> {
  return apiRequest('GET', '/api/mobile/intelligence/added', {
    query: { limit: ADDED_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    schema: addedPageSchema,
    ...bound(options),
  });
}

/** «مش هيك، شيله». A 409 `edited` is an `M5aRefusedError`: the row stays, and says why. */
export function removeAdded(autoAddId: string, options: Bound = {}) {
  return apiRequest('DELETE', `/api/mobile/intelligence/added/${encodeURIComponent(autoAddId)}`, {
    schema: addedRemovedSchema,
    ...bound(options),
  });
}
