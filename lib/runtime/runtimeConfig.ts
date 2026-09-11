/**
 * What a production process must be configured with, checked at boot
 * (UC-1.0e, #144).
 *
 * ── What this replaces ───────────────────────────────────────────
 *
 * `validatePilotRuntimeConfiguration` validated an HMAC token secret, a 25–40
 * participant allowlist and a durable data directory — three things that no
 * longer exist. Identity is a Firebase ID token, membership is gone, and
 * durable state is Firestore. What is left to get wrong is the project binding
 * and the storage backend, and both are worth failing the boot over rather
 * than discovering when the first user types something.
 *
 * ── Only on Cloud Run ────────────────────────────────────────────
 *
 * A developer's laptop runs against the emulators with no project bound and
 * the memory adapter, which is correct there and would be data loss in
 * production. `K_SERVICE` tells the two apart, and Cloud Run sets it itself.
 */

export class RuntimeConfigurationError extends Error {
  readonly reason = 'invalid_runtime_configuration';

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigurationError';
  }
}

/**
 * An environment variable that must never be set in production.
 *
 * No code in this repository reads `MAYBESITTER_DEV_AUTH`: UC-1.0e deliberately
 * shipped no development bypass, because a guard on `NODE_ENV` and `K_SERVICE`
 * tests *where* the code runs and never *who* is asking, and in a public
 * repository that is one environment variable away from uid impersonation.
 * Local development authenticates against the Firebase Auth emulator instead.
 * The name is refused here so that reintroducing the bypass fails the boot of
 * any production revision rather than passing review quietly.
 */
export const FORBIDDEN_IN_PRODUCTION = ['MAYBESITTER_DEV_AUTH'] as const;

export function validateRuntimeConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.K_SERVICE) return;

  if (!env.GOOGLE_CLOUD_PROJECT || !env.GOOGLE_CLOUD_PROJECT.trim()) {
    throw new RuntimeConfigurationError(
      'GOOGLE_CLOUD_PROJECT is required on Cloud Run: without it the Admin SDK binds to no project and every read fails at first use',
    );
  }

  if (env.MAYBESITTER_STORAGE_BACKEND !== 'firestore') {
    throw new RuntimeConfigurationError(
      `MAYBESITTER_STORAGE_BACKEND must be "firestore" on Cloud Run, not ${JSON.stringify(env.MAYBESITTER_STORAGE_BACKEND)}: in-memory storage is lost on every instance restart and is not shared between instances`,
    );
  }

  for (const name of FORBIDDEN_IN_PRODUCTION) {
    if (env[name] !== undefined) {
      throw new RuntimeConfigurationError(
        `${name} must not be set on Cloud Run: there is no development authentication path, and a revision that expects one is misconfigured`,
      );
    }
  }
}
