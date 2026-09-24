/** Public project identifier, never an account identifier or a credential. */
export const CLARITY_PROJECT_ID = 'ymeq5r7uc6';
export const CLARITY_PRIVACY_VERSION = 'strict-v1';

/** Opt-in build switch. Dashboard masking must be verified before enabling. */
export function clarityEnabled(): boolean {
  return process.env.EXPO_PUBLIC_CLARITY_ENABLED === 'true';
}
