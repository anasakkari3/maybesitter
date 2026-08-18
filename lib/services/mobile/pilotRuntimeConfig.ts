import path from 'node:path';
import { parseClosedPilotAllowlist } from '../../pilot/closedPilotControls';
import { alphaAllowlistConfigured, parseAlphaAllowlist } from '../../pilot/alphaControls';
import { getRequiredTokenSecret } from '../../pilot/pilotTokenService';

export class PilotRuntimeConfigurationError extends Error {
  readonly reason = 'invalid_pilot_runtime_configuration';

  constructor(message: string) {
    super(message);
  }
}

export function pilotModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MAYBESITTER_PILOT_MODE === 'true';
}

function requireDurableParticipantDataDir(env: NodeJS.ProcessEnv): string {
  const value = env.MAYBESITTER_DATA_DIR;
  if (!value || !value.trim()) {
    throw new PilotRuntimeConfigurationError('MAYBESITTER_DATA_DIR is required when MAYBESITTER_PILOT_MODE=true');
  }
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new PilotRuntimeConfigurationError('MAYBESITTER_DATA_DIR must be an absolute durable path when MAYBESITTER_PILOT_MODE=true');
  }
  const defaultLocalDir = path.join(process.cwd(), '.maybesitter');
  if (path.resolve(trimmed) === path.resolve(defaultLocalDir)) {
    throw new PilotRuntimeConfigurationError('MAYBESITTER_DATA_DIR must not use the local .maybesitter default when MAYBESITTER_PILOT_MODE=true');
  }
  return trimmed;
}

export function validatePilotRuntimeConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (!pilotModeEnabled(env)) return;

  try {
    getRequiredTokenSecret(env.MAYBESITTER_PILOT_TOKEN_SECRET);
  } catch (error) {
    throw new PilotRuntimeConfigurationError(error instanceof Error ? error.message : 'MAYBESITTER_PILOT_TOKEN_SECRET is invalid');
  }

  try {
    parseClosedPilotAllowlist(env.MAYBESITTER_CLOSED_PILOT_IDS);
  } catch (error) {
    // A small trusted-alpha run (1–10) is valid ONLY when the explicit alpha
    // allowlist is configured; otherwise the 25–40 closed-pilot contract stands.
    if (!alphaAllowlistConfigured(env)) {
      throw new PilotRuntimeConfigurationError(error instanceof Error ? error.message : 'MAYBESITTER_CLOSED_PILOT_IDS is invalid');
    }
  }
  if (alphaAllowlistConfigured(env)) {
    try {
      parseAlphaAllowlist(env.MAYBESITTER_ALPHA_IDS);
    } catch (error) {
      throw new PilotRuntimeConfigurationError(error instanceof Error ? error.message : 'MAYBESITTER_ALPHA_IDS is invalid');
    }
  }

  requireDurableParticipantDataDir(env);
}
