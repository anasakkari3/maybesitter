import type { CapabilityId } from '../../../src/contracts/v1/actionPolicyContracts';
import type {
  IntegrationCapability,
  KnownContextProviderKind,
} from '../../../src/contracts/v1/integrationConnectionContracts';

export type ProviderSurfaceId =
  | 'gmail'
  | 'microsoft_graph'
  | 'todoist'
  | 'notion'
  | 'rescuetime'
  | 'financial_sandbox';

export type ProviderPrepStage =
  | 'read_context'
  | 'external_task_sync'
  | 'controlled_external_action';

export interface ProviderCatalogEntry {
  readonly surface: ProviderSurfaceId;
  readonly provider: KnownContextProviderKind;
  readonly displayName: string;
  readonly prepStages: readonly ProviderPrepStage[];
  readonly connectionCapabilities: readonly IntegrationCapability[];
  readonly actionCapabilities: readonly CapabilityId[];
  /** Provider scope names are audit/config hints only; they are not secrets. */
  readonly providerScopes: readonly string[];
  readonly rawProviderToolsAllowedForModel: false;
}

export const PROVIDER_CONTEXT_CATALOG: readonly ProviderCatalogEntry[] = Object.freeze([
  {
    surface: 'gmail',
    provider: 'google',
    displayName: 'Gmail',
    prepStages: ['read_context', 'controlled_external_action'],
    connectionCapabilities: ['memory_context_read'],
    actionCapabilities: ['read_email', 'draft_email', 'send_email'],
    providerScopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.send',
    ],
    rawProviderToolsAllowedForModel: false,
  },
  {
    surface: 'microsoft_graph',
    provider: 'microsoft',
    displayName: 'Microsoft Graph',
    prepStages: ['read_context', 'external_task_sync', 'controlled_external_action'],
    connectionCapabilities: ['calendar_busy', 'calendar_free', 'task_read', 'task_write', 'meeting_read'],
    actionCapabilities: [
      'read_calendar',
      'read_email',
      'read_external_task',
      'read_meeting_context',
      'create_external_task',
      'update_external_task',
      'draft_email',
      'send_email',
    ],
    providerScopes: [
      'Calendars.Read',
      'Mail.Read',
      'Mail.Send',
      'Tasks.ReadWrite',
      'OnlineMeetings.Read',
    ],
    rawProviderToolsAllowedForModel: false,
  },
  {
    surface: 'todoist',
    provider: 'todoist',
    displayName: 'Todoist',
    prepStages: ['external_task_sync', 'controlled_external_action'],
    connectionCapabilities: ['task_read', 'task_write'],
    actionCapabilities: ['read_external_task', 'create_external_task', 'update_external_task'],
    providerScopes: ['data:read', 'data:write'],
    rawProviderToolsAllowedForModel: false,
  },
  {
    surface: 'notion',
    provider: 'notion',
    displayName: 'Notion',
    prepStages: ['read_context', 'external_task_sync', 'controlled_external_action'],
    connectionCapabilities: ['task_read', 'task_write', 'memory_context_read'],
    actionCapabilities: ['read_note_context', 'read_external_task', 'create_external_task', 'update_external_task'],
    providerScopes: ['read_content', 'insert_content', 'update_content'],
    rawProviderToolsAllowedForModel: false,
  },
  {
    surface: 'rescuetime',
    provider: 'rescuetime',
    displayName: 'RescueTime',
    prepStages: ['read_context'],
    connectionCapabilities: ['focus_session_read'],
    actionCapabilities: [],
    providerScopes: ['time_data:read'],
    rawProviderToolsAllowedForModel: false,
  },
  {
    surface: 'financial_sandbox',
    provider: 'financial_sandbox',
    displayName: 'Financial context (sandbox)',
    prepStages: ['read_context'],
    connectionCapabilities: ['financial_read'],
    /*
     * Empty, and not by omission. An action capability is something the
     * product may go and *do* at a provider; this surface only ever reads, and
     * the one action anybody would eventually want here moves money. Leaving
     * the list empty means there is no capability id for a future caller to
     * reach for.
     */
    actionCapabilities: [],
    providerScopes: ['accounts:read', 'balances:read', 'transactions:read', 'recurring:read'],
    rawProviderToolsAllowedForModel: false,
  },
] as const);

export function providerCatalogEntry(surface: ProviderSurfaceId): ProviderCatalogEntry {
  const entry = PROVIDER_CONTEXT_CATALOG.find((candidate) => candidate.surface === surface);
  if (!entry) {
    throw new Error(`Unknown provider surface: ${surface}`);
  }
  return entry;
}

export function providerCatalogForProvider(
  provider: KnownContextProviderKind,
): readonly ProviderCatalogEntry[] {
  return PROVIDER_CONTEXT_CATALOG.filter((entry) => entry.provider === provider);
}
