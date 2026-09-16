export type ExternalInstructionSignal =
  | 'role_override'
  | 'tool_request'
  | 'secret_request'
  | 'external_write_request'
  | 'data_deletion_request';

export interface UntrustedExternalContentBoundary {
  readonly trust: 'untrusted_external_content';
  readonly allowedEffect: 'interpret_or_propose_only';
  readonly privilegedActionAllowed: false;
  readonly injectionSignals: readonly ExternalInstructionSignal[];
}

const INJECTION_PATTERNS: readonly [ExternalInstructionSignal, RegExp][] = [
  ['role_override', /(?:ignore|override|replace).{0,30}(?:previous|system|developer).{0,20}(?:instruction|prompt|rule)/i],
  ['tool_request', /(?:call|invoke|run|execute).{0,30}(?:tool|function|mcp|api)/i],
  ['secret_request', /(?:reveal|send|print|expose).{0,30}(?:secret|token|password|credential|system prompt)/i],
  ['external_write_request', /(?:send (?:this )?email|create (?:a )?calendar|modify (?:the )?calendar|write (?:a )?task)/i],
  ['data_deletion_request', /(?:delete|erase|remove).{0,30}(?:data|email|calendar|task|account)/i],
];

export function detectExternalInstructionSignals(
  content: string,
): readonly ExternalInstructionSignal[] {
  return INJECTION_PATTERNS
    .filter(([, pattern]) => pattern.test(content))
    .map(([signal]) => signal);
}

export function untrustedExternalContentBoundary(content: string): UntrustedExternalContentBoundary {
  return {
    trust: 'untrusted_external_content',
    allowedEffect: 'interpret_or_propose_only',
    privilegedActionAllowed: false,
    injectionSignals: detectExternalInstructionSignals(content),
  };
}

export const EXTERNAL_CONTENT_SECURITY_POLICY = Object.freeze({
  contentIsInstruction: false,
  contentMaySelectCapability: false,
  contentMaySelectProviderTool: false,
  contentMayExecuteAction: false,
  confirmationMayBeDerivedFromContent: false,
});
