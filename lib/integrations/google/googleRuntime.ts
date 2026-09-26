/**
 * The Google chain's outside world, in one replaceable place (CL6a).
 *
 * Routes build their dependencies from here: the storage adapter, the
 * environment, the Secret Manager reader, `fetch`, the clock and the field
 * encryption options. Production uses the defaults. A test replaces the parts
 * it needs — a fake Google behind `fetchImpl`, an in-memory KMS — and the
 * route under test runs its real code against them, which is how the route
 * suites and the mobile fixture export exercise the whole chain with no
 * client secret in existence.
 *
 * A module-level override rather than a parameter on each route because a
 * Next.js route handler's signature is fixed.
 */
import { getStorage } from '../../storage';
import type { StorageAdapter } from '../../storage/storageAdapter';
import type { FieldEncryptionOptions } from '../../security/fieldEncryption';
import { secretManagerReader, type GoogleConfigEnv, type GoogleSecretReader } from './googleConfig';

export interface GoogleRuntime {
  readonly storage: StorageAdapter;
  readonly env: GoogleConfigEnv;
  readonly secrets: GoogleSecretReader | null;
  readonly fetchImpl: typeof fetch;
  readonly now: () => Date;
  readonly random?: (size: number) => Buffer;
  readonly encryption?: FieldEncryptionOptions;
}

let overrides: Partial<GoogleRuntime> | null = null;

export function googleRuntime(): GoogleRuntime {
  const env = overrides?.env ?? (process.env as GoogleConfigEnv);
  return {
    storage: overrides?.storage ?? getStorage(),
    env,
    secrets: overrides && 'secrets' in overrides ? overrides.secrets ?? null : secretManagerReader(env),
    // Read at call time, not captured at import, so a test's global stub and a
    // late-installed polyfill are both honoured.
    fetchImpl: overrides?.fetchImpl ?? ((input, init) => fetch(input, init)),
    now: overrides?.now ?? (() => new Date()),
    ...(overrides?.random ? { random: overrides.random } : {}),
    ...(overrides?.encryption ? { encryption: overrides.encryption } : {}),
  };
}

export function setGoogleRuntimeForTests(next: Partial<GoogleRuntime>): void {
  overrides = next;
}

export function resetGoogleRuntimeForTests(): void {
  overrides = null;
}
