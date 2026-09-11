/**
 * The boundary around the stores that stayed on local disk (UC-1.0c, #142).
 *
 * A handful of modules deliberately did *not* move onto the storage adapter:
 * offline annotation tooling, the pilot backup helpers, and the legacy web
 * UI's own stores. They are all correct on a laptop and all wrong on Cloud
 * Run, where the filesystem is per-instance and disappears with the revision.
 * This is the one function that says so, and it says so by failing.
 *
 * ── Why `K_SERVICE` and not a config flag ────────────────────────
 *
 * Cloud Run sets `K_SERVICE` on every revision itself, so the check cannot be
 * forgotten by a deployment that forgot to set something. `lib/storage/index`
 * picks its backend the same way and for the same reason.
 *
 * ── Why first use, and never module init ─────────────────────────
 *
 * Calling this at module scope would throw while the module graph is being
 * built. Next collects route modules at build time and again on boot, so a
 * throw there fails the *build* — or takes the whole server down — rather than
 * failing the one request that reached the offline-only code. The difference
 * matters: every other route in the deployment is fine, and should keep
 * serving. Put the call inside the function or constructor that actually
 * touches the disk, so the blast radius is one 500 on one endpoint instead of
 * a revision that will not start.
 *
 * The error names the caller and the reason, because whoever sees it in a
 * Cloud Run log needs to know which store it was and what to use instead.
 */

/** Set by Cloud Run on every revision. Not something a deployment configures. */
export const CLOUD_RUN_ENV_VAR = 'K_SERVICE';

export class CloudRunUnsupportedStoreError extends Error {
  constructor(message: string, readonly store: string) {
    super(message);
    this.name = 'CloudRunUnsupportedStoreError';
  }
}

/**
 * Typed as a plain string map rather than `NodeJS.ProcessEnv`, which requires
 * `NODE_ENV` and so makes an inline `{ K_SERVICE: 'x' }` in a test a type
 * error. `process.env` is assignable to this, and the guard reads one key.
 */
export type EnvLike = Record<string, string | undefined>;

export function onCloudRun(env: EnvLike = process.env): boolean {
  return Boolean(env[CLOUD_RUN_ENV_VAR]);
}

/**
 * Refuses to run a local-disk-backed store on Cloud Run.
 *
 * @param store  The module being guarded, as it would be named in a log.
 * @param reason Why it is local-only, and what the durable path is instead.
 */
export function assertNotCloudRun(
  store: string,
  reason: string,
  env: EnvLike = process.env,
): void {
  if (!onCloudRun(env)) return;
  throw new CloudRunUnsupportedStoreError(
    `${store} writes to the local filesystem and is not available on Cloud Run `
      + `(${CLOUD_RUN_ENV_VAR}=${String(env[CLOUD_RUN_ENV_VAR])}): ${reason}`,
    store,
  );
}
