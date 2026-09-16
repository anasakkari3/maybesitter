import { createHash } from 'node:crypto';
import type {
  IntegrationCapability,
  IntegrationConnectionRecord,
} from '../../../src/contracts/v1/integrationConnectionContracts';
import type { ExternalTaskReference } from '../../../src/contracts/v1/externalTaskContracts';
import { normalizeMicrosoftTask } from '../tasks/externalTaskNormalizer';
import {
  buildProviderDisconnectRequest,
  planProviderSync,
  type ProviderDisconnectRequest,
  type ProviderOAuthTokenMetadata,
  type ProviderSyncPlan,
} from '../providers/providerRuntime';
import {
  untrustedExternalContentBoundary,
  type ExternalInstructionSignal,
} from '../providers/untrustedExternalContent';

export const MICROSOFT_GRAPH_PROVIDER = 'microsoft' as const;

export const MICROSOFT_GRAPH_SCOPES = Object.freeze({
  identity: 'User.Read',
  offline: 'offline_access',
  mailRead: 'Mail.Read',
  mailDraft: 'Mail.ReadWrite',
  mailSend: 'Mail.Send',
  calendarRead: 'Calendars.Read',
  tasksRead: 'Tasks.Read',
  tasksWrite: 'Tasks.ReadWrite',
} as const);

export type MicrosoftGraphResource = 'mail' | 'calendar' | 'tasks';

export interface MicrosoftGraphCursorSet {
  readonly mail: string | null;
  readonly calendar: string | null;
  readonly tasks: string | null;
}

export interface MicrosoftMailPayload {
  readonly id: string;
  readonly conversationId: string | null;
  readonly receivedAt: string;
  readonly from: string | null;
  readonly subject: string | null;
  readonly text: string;
  readonly changeKey: string | null;
}

export interface MicrosoftUntrustedMailContext {
  readonly trust: 'untrusted_external_content';
  readonly allowedEffect: 'interpret_or_propose_only';
  readonly privilegedActionAllowed: false;
  readonly injectionSignals: readonly ExternalInstructionSignal[];
  readonly contentClass: 'email';
  readonly provider: typeof MICROSOFT_GRAPH_PROVIDER;
  readonly connectionId: string;
  readonly externalId: string;
  readonly conversationId: string | null;
  readonly receivedAt: string;
  readonly from: string | null;
  readonly subject: string | null;
  readonly text: string;
  readonly dedupeKey: string;
  readonly provenance: { readonly source: 'outlook_mail'; readonly fetchedAt: string };
}

export interface MicrosoftCalendarPayload {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly cancelled: boolean;
  readonly changeKey: string | null;
  readonly subject?: string;
  readonly location?: string;
}

export interface MicrosoftBusyContext {
  readonly provider: typeof MICROSOFT_GRAPH_PROVIDER;
  readonly connectionId: string;
  readonly externalId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly blocking: boolean;
  readonly dedupeKey: string;
  readonly provenance: { readonly source: 'outlook_calendar'; readonly fetchedAt: string };
}

export interface MicrosoftTodoPayload {
  readonly id: string;
  readonly listId: string;
  readonly title: string;
  readonly body: string | null;
  readonly dueAt: string | null;
  readonly completed: boolean;
  readonly updatedAt: string;
  readonly webUrl: string | null;
}

export function microsoftScopesForCapabilities(
  capabilities: readonly IntegrationCapability[],
): readonly string[] {
  const scopes: string[] = [MICROSOFT_GRAPH_SCOPES.identity, MICROSOFT_GRAPH_SCOPES.offline];
  if (capabilities.includes('mail_read')) scopes.push(MICROSOFT_GRAPH_SCOPES.mailRead);
  if (capabilities.includes('mail_draft')) scopes.push(MICROSOFT_GRAPH_SCOPES.mailDraft);
  if (capabilities.includes('mail_send')) scopes.push(MICROSOFT_GRAPH_SCOPES.mailSend);
  if (capabilities.includes('calendar_busy') || capabilities.includes('calendar_free')) {
    scopes.push(MICROSOFT_GRAPH_SCOPES.calendarRead);
  }
  if (capabilities.includes('task_write')) scopes.push(MICROSOFT_GRAPH_SCOPES.tasksWrite);
  else if (capabilities.includes('task_read')) scopes.push(MICROSOFT_GRAPH_SCOPES.tasksRead);
  return Object.freeze(Array.from(new Set(scopes)).sort());
}

export function encodeMicrosoftGraphCursors(cursors: MicrosoftGraphCursorSet): string {
  return JSON.stringify({
    calendar: cursors.calendar,
    mail: cursors.mail,
    tasks: cursors.tasks,
  });
}

export function decodeMicrosoftGraphCursors(cursor: string | null | undefined): MicrosoftGraphCursorSet {
  if (!cursor) return { mail: null, calendar: null, tasks: null };
  try {
    const parsed = JSON.parse(cursor) as Record<string, unknown>;
    return {
      mail: typeof parsed.mail === 'string' ? parsed.mail : null,
      calendar: typeof parsed.calendar === 'string' ? parsed.calendar : null,
      tasks: typeof parsed.tasks === 'string' ? parsed.tasks : null,
    };
  } catch {
    return { mail: null, calendar: null, tasks: null };
  }
}

export function planMicrosoftGraphSync(
  connection: IntegrationConnectionRecord,
  token: ProviderOAuthTokenMetadata | null,
  resource: MicrosoftGraphResource,
  now: string,
): ProviderSyncPlan & { readonly resource: MicrosoftGraphResource; readonly deltaCursor: string | null } {
  const requiredCapabilities: Record<MicrosoftGraphResource, readonly IntegrationCapability[]> = {
    mail: ['mail_read'],
    calendar: ['calendar_busy'],
    tasks: ['task_read'],
  };
  const plan = planProviderSync(connection, {
    provider: MICROSOFT_GRAPH_PROVIDER,
    requiredCapabilities: requiredCapabilities[resource],
    token,
  }, now);
  const cursors = decodeMicrosoftGraphCursors(plan.cursor);
  return { ...plan, resource, deltaCursor: plan.shouldSync ? cursors[resource] : null };
}

export function normalizeMicrosoftMail(
  payload: MicrosoftMailPayload,
  connectionId: string,
  fetchedAt: string,
): MicrosoftUntrustedMailContext {
  requireIdAndTime(payload.id, payload.receivedAt, 'mail');
  const boundary = untrustedExternalContentBoundary([payload.subject ?? '', payload.text].join('\n'));
  return {
    ...boundary,
    contentClass: 'email',
    provider: MICROSOFT_GRAPH_PROVIDER,
    connectionId,
    externalId: payload.id,
    conversationId: payload.conversationId,
    receivedAt: payload.receivedAt,
    from: payload.from,
    subject: payload.subject,
    text: payload.text,
    dedupeKey: digest(`outlook-mail\0${connectionId}\0${payload.id}`),
    provenance: { source: 'outlook_mail', fetchedAt },
  };
}

export function normalizeMicrosoftBusyContext(
  payload: MicrosoftCalendarPayload,
  connectionId: string,
  fetchedAt: string,
): MicrosoftBusyContext | null {
  requireIdAndTime(payload.id, payload.startsAt, 'calendar');
  if (!Number.isFinite(Date.parse(payload.endsAt)) || Date.parse(payload.endsAt) <= Date.parse(payload.startsAt)) {
    throw new TypeError('Malformed Microsoft calendar interval');
  }
  if (payload.cancelled) return null;
  return {
    provider: MICROSOFT_GRAPH_PROVIDER,
    connectionId,
    externalId: payload.id,
    startsAt: payload.startsAt,
    endsAt: payload.endsAt,
    allDay: payload.allDay,
    blocking: !payload.allDay,
    dedupeKey: digest(`outlook-calendar\0${connectionId}\0${payload.id}\0${payload.startsAt}`),
    provenance: { source: 'outlook_calendar', fetchedAt },
  };
}

export function normalizeMicrosoftTodo(
  payload: MicrosoftTodoPayload,
  connection: IntegrationConnectionRecord,
): ExternalTaskReference {
  requireIdAndTime(payload.id, payload.updatedAt, 'task');
  return normalizeMicrosoftTask({
    scopeId: connection.scopeId,
    connectionId: connection.connectionId,
    providerIdentity: connection.identity,
    externalId: payload.id,
    externalUrl: payload.webUrl,
    title: payload.title,
    notes: payload.body,
    dueAt: payload.dueAt,
    completed: payload.completed,
    updatedAt: payload.updatedAt,
    lastSyncedAt: connection.lastSyncedAt,
  });
}

export function buildMicrosoftGraphDisconnectRequest(
  connectionId: string,
  requestedAt: string,
): ProviderDisconnectRequest {
  return buildProviderDisconnectRequest(MICROSOFT_GRAPH_PROVIDER, connectionId, requestedAt);
}

export const MICROSOFT_GRAPH_DATA_POLICY = Object.freeze({
  mailboxMirrorAllowed: false,
  calendarTitlesStoredForPlanning: false,
  providerSpecificPlanningLogicAllowed: false,
  externalMailMayExecuteActions: false,
  deltaCursorsOpaqueOutsideAdapter: true,
});

function requireIdAndTime(id: string, time: string, kind: string): void {
  if (!id.trim() || !Number.isFinite(Date.parse(time))) {
    throw new TypeError(`Malformed Microsoft ${kind} payload`);
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
