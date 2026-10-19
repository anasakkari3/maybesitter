import { getStorage } from '../storage';
import type { StorageAdapter, StorageTransaction } from '../storage/storageAdapter';
import { readRuntimeBoolean } from '../../src/contracts/v1/runtimeControls';

export const M5A_CONTROLS_PATH = 'system/m5aControls';
export const M5A_CONTROLS_LOG = 'system/m5aControlsLog';
export type M5aCapability = 'email' | 'calendar';

export interface M5aControl { readonly epoch: number; readonly enabled: boolean }
export interface M5aControls {
  readonly email: M5aControl;
  readonly calendar: M5aControl;
}

export const INITIAL_M5A_CONTROLS: M5aControls = Object.freeze({
  email: Object.freeze({ epoch: 0, enabled: false }),
  calendar: Object.freeze({ epoch: 0, enabled: false }),
});

function validControl(value: unknown): value is M5aControl {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2
    && Number.isSafeInteger(row.epoch) && (row.epoch as number) >= 0
    && typeof row.enabled === 'boolean';
}

export function parseM5aControls(value: unknown): M5aControls | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || !validControl(row.email) || !validControl(row.calendar)) return null;
  return { email: { ...row.email }, calendar: { ...row.calendar } };
}

export async function readM5aControls(storage: StorageAdapter = getStorage()): Promise<M5aControls | null> {
  try { return parseM5aControls(await storage.get(M5A_CONTROLS_PATH)); }
  catch { return null; }
}

function environmentAllowed(env: Record<string, string | undefined>): boolean {
  const name = (env.MAYBESITTER_ENV ?? 'local').trim().toLowerCase() || 'local';
  return name === 'local' || name === 'test' || name === 'staging';
}

export function m5aEnvironmentCapability(capability: M5aCapability, env: Record<string, string | undefined> = process.env): boolean {
  const suffix = capability === 'calendar' ? 'CALENDAR_CHOICE' : 'EMAIL_SOURCES';
  return environmentAllowed(env)
    && readRuntimeBoolean(env[`MAYBESITTER_FEATURE_${suffix}`], false)
    && !readRuntimeBoolean(env[`MAYBESITTER_KILL_SWITCH_${suffix}`], false);
}

/** One resolver used by the public probe and admissions. Missing/bad storage fails closed. */
export async function resolveM5aCapabilities(
  options: { storage?: StorageAdapter; env?: Record<string, string | undefined> } = {},
): Promise<{ calendarChoice: boolean; emailSources: boolean; controls: M5aControls | null }> {
  const controls = await readM5aControls(options.storage);
  const env = options.env ?? process.env;
  return {
    calendarChoice: Boolean(controls?.calendar.enabled) && m5aEnvironmentCapability('calendar', env),
    emailSources: Boolean(controls?.email.enabled) && m5aEnvironmentCapability('email', env),
    controls,
  };
}

export function requireControlInTransaction(
  tx: StorageTransaction,
  capability: M5aCapability,
  expectedEpoch?: number,
): Promise<M5aControl> {
  return tx.get<unknown>(M5A_CONTROLS_PATH).then((raw) => {
    const controls = parseM5aControls(raw);
    const control = controls?.[capability];
    if (!control?.enabled || (expectedEpoch !== undefined && control.epoch !== expectedEpoch)) {
      throw new M5aControlError('m5_unavailable');
    }
    return control;
  });
}

export class M5aControlError extends Error {
  constructor(readonly code: 'm5_unavailable' | 'already_initialized' | 'not_initialized' | 'epoch_mismatch') {
    super(code);
    this.name = 'M5aControlError';
  }
}
