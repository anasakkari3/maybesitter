import {
  executeThroughActionGateway,
  type ActionGatewayAuditStore,
  type ActionGatewayRequest,
  type ActionGatewayResult,
} from '../actions/actionGateway';

export type McpCapabilityMode = 'context_read' | 'controlled_write';

export interface McpCapabilityBinding {
  readonly bindingId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly mode: McpCapabilityMode;
  readonly configuredBy: 'operator';
}

export interface McpTransportResult {
  readonly executionId: string;
  readonly resultRef: string | null;
  readonly content: unknown;
}

export interface McpTransport {
  call(input: {
    readonly serverId: string;
    readonly toolName: string;
    readonly payload: unknown;
    readonly idempotencyKey: string;
  }): Promise<McpTransportResult>;
}

export interface UntrustedMcpContent {
  readonly authority: 'untrusted_provider_data';
  readonly maySelectCapability: false;
  readonly maySelectTool: false;
  readonly mayConfirmAction: false;
  readonly content: unknown;
}

export type McpCapabilityResult =
  | { readonly status: 'unknown_binding'; readonly content: null }
  | {
    readonly status: 'gateway_result';
    readonly gateway: ActionGatewayResult;
    readonly content: UntrustedMcpContent | null;
  };

export const MCP_CAPABILITY_POLICY = Object.freeze({
  bindingsConfiguredByOperatorOnly: true,
  providerManifestMayGrantCapability: false,
  modelMaySelectRawTool: false,
  providerContentMayConfirmAction: false,
  writesPassThroughActionGateway: true,
});

export class McpCapabilityRegistry {
  private readonly bindings = new Map<string, McpCapabilityBinding>();

  constructor(bindings: readonly McpCapabilityBinding[]) {
    for (const binding of bindings) {
      if (binding.configuredBy !== 'operator') throw new Error('MCP bindings require operator configuration');
      if (this.bindings.has(binding.bindingId)) throw new Error('MCP binding ids must be unique');
      this.bindings.set(binding.bindingId, Object.freeze({ ...binding }));
    }
  }

  get(bindingId: string): McpCapabilityBinding | null {
    return this.bindings.get(bindingId) ?? null;
  }
}

export async function executeMcpCapability(input: {
  readonly registry: McpCapabilityRegistry;
  readonly bindingId: string;
  readonly request: Omit<ActionGatewayRequest, 'capability' | 'provider'>;
  readonly audit: ActionGatewayAuditStore;
  readonly transport: McpTransport;
}): Promise<McpCapabilityResult> {
  const binding = input.registry.get(input.bindingId);
  if (!binding) return { status: 'unknown_binding', content: null };

  let providerContent: unknown;
  let hasProviderContent = false;
  const capability = binding.mode === 'context_read' ? 'mcp_lookup_context' : 'mcp_execute_capability';
  const gateway = await executeThroughActionGateway({
    ...input.request,
    capability,
    provider: 'mcp',
  }, {
    audit: input.audit,
    executor: {
      async execute(action) {
        const providerResult = await input.transport.call({
          serverId: binding.serverId,
          toolName: binding.toolName,
          payload: action.payload,
          idempotencyKey: action.idempotencyKey,
        });
        providerContent = providerResult.content;
        hasProviderContent = true;
        return {
          executionId: providerResult.executionId,
          resultRef: providerResult.resultRef,
        };
      },
    },
  });

  return {
    status: 'gateway_result',
    gateway,
    content: !hasProviderContent ? null : {
      authority: 'untrusted_provider_data',
      maySelectCapability: false,
      maySelectTool: false,
      mayConfirmAction: false,
      content: providerContent,
    },
  };
}
