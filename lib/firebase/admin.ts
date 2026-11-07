/**
 * The one place this repo initialises the Firebase Admin SDK (UC-1.0b, #141).
 *
 * Lazy on purpose: importing this module must not touch the network, read a
 * credential or bind a project, because it is pulled in by `lib/storage` which
 * is pulled in by every route — including the ones running under `npm test`
 * against the in-memory adapter, where no Google project exists at all.
 *
 * Credentials come from Application Default Credentials. On Cloud Run that is
 * the service account attached to the revision; locally it is
 * `gcloud auth application-default login`. Neither is read here.
 *
 * `FIRESTORE_EMULATOR_HOST` and `FIREBASE_AUTH_EMULATOR_HOST` are honoured by
 * the SDK itself: when either is set the SDK talks to the emulator and never
 * asks for a credential, which is what makes `npm run test:emulator` work with
 * no service account on the machine.
 */
import { getApps, initializeApp, type App } from 'firebase-admin/app';

let cached: App | null = null;

/** A production revision configured to talk to the Firebase emulators. */
export class EmulatorInProductionError extends Error {
  constructor() {
    super('firebase emulator host set in production');
    this.name = 'EmulatorInProductionError';
  }
}

/**
 * Production never talks to an emulator. With an emulator host set, the SDK
 * accepts unsigned Auth-emulator ID tokens and reads and writes an emulator
 * database, so a misconfigured production revision would fail open. The admin
 * app is the one init point for token verification and Firestore, so refusing
 * here fails both closed: auth answers 503 `auth_unavailable`, storage throws,
 * and the readiness probe reports storage unavailable. Any other environment,
 * including the emulator suite (no `MAYBESITTER_ENV`), is unaffected.
 */
export function assertNoEmulatorInProduction(env: Record<string, string | undefined> = process.env): void {
  if ((env.MAYBESITTER_ENV ?? '').trim().toLowerCase() !== 'production') return;
  if (env.FIREBASE_AUTH_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST) throw new EmulatorInProductionError();
}

/** The project id ADC-based initialisation should bind to, if one is configured. */
export function resolveProjectId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.FIREBASE_PROJECT_ID || undefined;
}

/**
 * The admin app, created on first use and reused afterwards.
 *
 * An app another module already initialised wins, so a host that boots the SDK
 * its own way (a Cloud Function, a test harness) does not end up with two.
 */
export function getAdminApp(): App {
  assertNoEmulatorInProduction();
  if (cached) return cached;
  const existing = getApps();
  cached = existing.length > 0
    ? existing[0]
    : initializeApp({ projectId: resolveProjectId() });
  return cached;
}

/** Drops the memoised app so a test can rebind the environment. */
export function resetAdminAppForTests(): void {
  cached = null;
}
