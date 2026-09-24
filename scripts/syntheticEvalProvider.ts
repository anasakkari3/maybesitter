/** CLI-only synthetic corpus adapter. Never persist or alter a user's consent. */
import { captureLlmProvider, type CaptureProviderOptions } from '../lib/llm/captureProvider';
import { consentGatedProvider } from '../lib/llm/consentGatedProvider';
import { configuredProviderName, type LLMProviderFunction } from '../src/extraction/llm';

export type SyntheticEvalPurpose = 'capture_extraction' | 'profile_extraction';
/** Tests substitute I/O, while retaining the real two consent gates and meter. */
export type SyntheticEvalDependencies = Pick<CaptureProviderOptions, 'provider' | 'reserve' | 'commit' | 'log'>;

export function syntheticEvalProvider(
  purpose: SyntheticEvalPurpose,
  dependencies: SyntheticEvalDependencies = {},
): LLMProviderFunction {
  if (configuredProviderName() !== 'gemini') {
    throw new Error('A Gemini evaluation requires MAYBESITTER_LLM_PROVIDER=gemini and configured Vertex credentials.');
  }
  // An environment override must not charge a real user's quota or manufacture
  // consent for their account. These identities belong only to synthetic runs.
  const uid = purpose === 'capture_extraction' ? 'capture-eval-harness' : 'profile-eval-harness';
  const consent = async (requestedUid: string) => requestedUid === uid ? 'granted' as const : 'declined' as const;
  const provider = consentGatedProvider(uid, { provider: dependencies.provider, consent });
  return captureLlmProvider(uid, {
    ...dependencies,
    provider,
    consent,
    purpose,
    // Preserve the capture batch contract, not an unlimited budget: minute,
    // token caps, the global kill switch, reservations and usage logging remain.
    reserveOptions: { userCap: Number.MAX_SAFE_INTEGER, globalCap: Number.MAX_SAFE_INTEGER },
  });
}
