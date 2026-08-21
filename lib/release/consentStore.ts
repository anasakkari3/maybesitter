/**
 * The shadow study's consent store (Sprint 11, issue #47).
 *
 * ── Why a second consent store ───────────────────────────────────
 *
 * Sprint 10's `PersonalizationConsentStore` answers "may we personalise for
 * this scope". This one answers "is this person in the shadow study, and for
 * which of its three separately-refusable parts". They are different questions
 * with different subjects — a *scope* versus a *participant* — and a single
 * flag that meant both would be a consent a person could not withdraw from the
 * study without also turning off personalization. `ShadowConsentScope` exists
 * in the contract precisely because the parts are separately refusable.
 *
 * What is *not* duplicated is the mechanism: this file is structurally
 * `lib/personalizationControls/consentStore.ts` — one semantics implementation
 * over a persistence seam, ids hashed before they name a file, temp-then-rename
 * at mode 0600, no ambient clock, and unreadable state reading as the
 * fail-closed default.
 *
 * ── Revocation is a shape, and this store keeps it one ───────────
 *
 * `ShadowRevokedConsent` carries `scopes: readonly []` in the type. This store
 * never writes a revoked record with scopes on it, and — more usefully — never
 * *reads* one: a stored record whose state is not `granted` has its scopes
 * dropped on the way out. So a hand-edited file that put scopes back on a
 * revoked consent cannot hand a live scope to a consumer.
 *
 * ── Reports, never throws ────────────────────────────────────────
 *
 * Every write returns a result variant naming why it was refused. The pilot's
 * `applyPilotTrustAction` throws instead, and that is the older half of the
 * seam; this half is called from an HTTP handler, where a throw is a 500 and a
 * stack trace rather than something a client can act on.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  SHADOW_CONSENT_SCOPES,
  SHADOW_CONSENT_STATES,
  SHADOW_SAFE_CODE,
  isInstant,
  millisBetweenInstants,
  type Instant,
  type ShadowConsentScope,
  type ShadowConsentState,
  type ShadowStudyConsent,
} from '../../src/contracts/v1/shadowPipelineContracts';

const CONSENT_SUBDIR = 'shadow-study-consent';
const CONSENT_FILE_EXT = '.study-consent.json';
const TEMP_FILE_EXT = '.tmp';
const CONSENT_ID_PREFIX = 'ssc_';
export const SHADOW_STUDY_CONSENT_SCHEMA_VERSION = 'shadow-study-consent-v1' as const;

/**
 * Why a write was refused. Declared as data so a test can enumerate it and
 * prove every branch is reachable — a rejection nobody can produce is a
 * rejection nobody has checked.
 */
export const SHADOW_CONSENT_WRITE_REJECTIONS = Object.freeze([
  'unsafe_participant',
  'no_scopes',
  'unknown_scope',
  'malformed_instant',
  'nothing_to_revoke',
  'already_revoked',
  'backdated',
] as const);

export type ShadowConsentWriteRejection = (typeof SHADOW_CONSENT_WRITE_REJECTIONS)[number];

export type ShadowConsentWriteResult =
  | { readonly status: 'written'; readonly consent: ShadowStudyConsent }
  | {
      readonly status: 'rejected';
      readonly reason: ShadowConsentWriteRejection;
      readonly detail: string;
      /** The state the store still holds. A refused write changes nothing. */
      readonly consent: ShadowStudyConsent;
    };

export interface ShadowStudyConsentStore {
  /** Never throws for any input: unreadable state is the withheld default. */
  read(participantId: string): ShadowStudyConsent;
  grant(
    participantId: string,
    scopes: readonly ShadowConsentScope[],
    at: Instant,
  ): ShadowConsentWriteResult;
  revoke(participantId: string, at: Instant): ShadowConsentWriteResult;
  /** Removes the record outright. Returns 1 or 0; verify by re-reading. */
  deleteParticipant(participantId: string): number;
  /** 1 when a record exists for this participant, 0 otherwise. */
  countFor(participantId: string): number;
  /** Storage order, which is insertion order. Nothing here sorts anything. */
  listParticipants(): readonly string[];
}

export interface ShadowStudyConsentStoreOptions {
  readonly dataDir?: string;
}

interface StoredConsent {
  readonly version: typeof SHADOW_STUDY_CONSENT_SCHEMA_VERSION;
  readonly participantId: string;
  readonly state: ShadowConsentState;
  readonly scopes: readonly ShadowConsentScope[];
  readonly grantedAt: string | null;
  readonly revokedAt: string | null;
}

function withheld(participantId: string): ShadowStudyConsent {
  return Object.freeze({
    state: 'withheld',
    participantId,
    scopes: [] as const,
    grantedAt: null,
    revokedAt: null,
  });
}

function isSafeParticipant(value: unknown): value is string {
  return typeof value === 'string' && SHADOW_SAFE_CODE.test(value);
}

function isKnownScope(value: unknown): value is ShadowConsentScope {
  return (SHADOW_CONSENT_SCOPES as readonly unknown[]).includes(value);
}

function isStoredConsent(value: unknown): value is StoredConsent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.version !== SHADOW_STUDY_CONSENT_SCHEMA_VERSION) return false;
  if (!isSafeParticipant(raw.participantId)) return false;
  if (!(SHADOW_CONSENT_STATES as readonly unknown[]).includes(raw.state)) return false;
  if (!Array.isArray(raw.scopes) || !raw.scopes.every(isKnownScope)) return false;
  if (raw.grantedAt !== null && !isInstant(raw.grantedAt)) return false;
  if (raw.revokedAt !== null && !isInstant(raw.revokedAt)) return false;
  return true;
}

/**
 * The stored record, read as the contract's union.
 *
 * A stored record that cannot make a well-formed variant reads as `withheld`
 * rather than as a partially-populated grant: fail-closed is the direction, and
 * "we could not read your consent" must never resolve to "you consented".
 */
function toConsent(record: StoredConsent | null, participantId: string): ShadowStudyConsent {
  if (record === null || record.participantId !== participantId) return withheld(participantId);

  if (record.state === 'granted') {
    const [first, ...rest] = record.scopes;
    if (first === undefined || record.grantedAt === null) return withheld(participantId);
    return Object.freeze({
      state: 'granted',
      participantId,
      scopes: [first, ...rest] as const,
      grantedAt: record.grantedAt,
      revokedAt: null,
    });
  }

  if (record.state === 'revoked') {
    if (record.grantedAt === null || record.revokedAt === null) return withheld(participantId);
    // Scopes are dropped here rather than trusted: a revoked record that
    // carried scopes must not hand a live one to a consumer.
    return Object.freeze({
      state: 'revoked',
      participantId,
      scopes: [] as const,
      grantedAt: record.grantedAt,
      revokedAt: record.revokedAt,
    });
  }

  return withheld(participantId);
}

interface ConsentRepository {
  readOne(participantId: string): StoredConsent | null;
  write(record: StoredConsent): void;
  remove(participantId: string): boolean;
  listIds(): readonly string[];
}

function createStore(repository: ConsentRepository): ShadowStudyConsentStore {
  function current(participantId: string): ShadowStudyConsent {
    if (!isSafeParticipant(participantId)) return withheld(String(participantId));
    return toConsent(repository.readOne(participantId), participantId);
  }

  function reject(
    participantId: string,
    reason: ShadowConsentWriteRejection,
    detail: string,
  ): ShadowConsentWriteResult {
    return { status: 'rejected', reason, detail, consent: current(participantId) };
  }

  return {
    read: current,

    grant(participantId, scopes, at): ShadowConsentWriteResult {
      if (!isSafeParticipant(participantId)) {
        return reject(participantId, 'unsafe_participant', 'participantId is outside the safe-code pattern');
      }
      if (!Array.isArray(scopes) || scopes.length === 0) {
        return reject(participantId, 'no_scopes', 'a granted consent must grant at least one scope');
      }
      const unknown = scopes.filter((scope) => !isKnownScope(scope));
      if (unknown.length > 0) {
        return reject(
          participantId,
          'unknown_scope',
          `not a study consent scope: ${unknown.map((scope) => String(scope)).join(', ')}`,
        );
      }
      if (!isInstant(at)) {
        return reject(participantId, 'malformed_instant', `not an ISO instant with an explicit offset: ${String(at)}`);
      }
      // Declaration order of the vocabulary, and each scope once: a caller who
      // sent the same scope twice consented to it once.
      const deduped = SHADOW_CONSENT_SCOPES.filter((scope) => scopes.includes(scope));
      repository.write({
        version: SHADOW_STUDY_CONSENT_SCHEMA_VERSION,
        participantId,
        state: 'granted',
        scopes: deduped,
        grantedAt: at,
        revokedAt: null,
      });
      return { status: 'written', consent: current(participantId) };
    },

    revoke(participantId, at): ShadowConsentWriteResult {
      if (!isSafeParticipant(participantId)) {
        return reject(participantId, 'unsafe_participant', 'participantId is outside the safe-code pattern');
      }
      if (!isInstant(at)) {
        return reject(participantId, 'malformed_instant', `not an ISO instant with an explicit offset: ${String(at)}`);
      }
      const existing = current(participantId);
      if (existing.state === 'withheld') {
        // A revocation of a consent that was never granted is not a
        // revocation, and `ShadowRevokedConsent` has no shape for it — its
        // `grantedAt` is non-null by construction.
        return reject(participantId, 'nothing_to_revoke', 'this participant has no granted consent to withdraw');
      }
      if (existing.state === 'revoked') {
        return reject(participantId, 'already_revoked', `consent was already withdrawn at ${existing.revokedAt}`);
      }
      const elapsed = millisBetweenInstants(existing.grantedAt, at);
      if (elapsed === null || elapsed < 0) {
        return reject(
          participantId,
          'backdated',
          `a consent granted at ${existing.grantedAt} cannot be withdrawn at ${at}`,
        );
      }
      repository.write({
        version: SHADOW_STUDY_CONSENT_SCHEMA_VERSION,
        participantId,
        state: 'revoked',
        scopes: [],
        grantedAt: existing.grantedAt,
        revokedAt: at,
      });
      return { status: 'written', consent: current(participantId) };
    },

    deleteParticipant(participantId): number {
      if (!isSafeParticipant(participantId)) return 0;
      return repository.remove(participantId) ? 1 : 0;
    },

    countFor(participantId): number {
      if (!isSafeParticipant(participantId)) return 0;
      const record = repository.readOne(participantId);
      return record !== null && record.participantId === participantId ? 1 : 0;
    },

    listParticipants(): readonly string[] {
      return repository.listIds();
    },
  };
}

function defaultDataDir(): string {
  const root = process.env.MAYBESITTER_DATA_DIR || path.join(process.cwd(), '.maybesitter');
  return path.join(root, CONSENT_SUBDIR);
}

/** Participant ids are caller text, so they are hashed before naming a file. */
function consentFileId(participantId: string): string {
  return `${CONSENT_ID_PREFIX}${createHash('sha256').update(participantId, 'utf8').digest('hex')}`;
}

function createFileRepository(resolveDataDir: () => string): ConsentRepository {
  function ensureDir(): string {
    const dataDir = resolveDataDir();
    mkdirSync(dataDir, { recursive: true });
    return dataDir;
  }

  function filePathFor(dataDir: string, participantId: string): string {
    return path.join(dataDir, `${consentFileId(participantId)}${CONSENT_FILE_EXT}`);
  }

  function readFile(file: string): StoredConsent | null {
    if (!existsSync(file)) return null;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (isStoredConsent(raw)) return raw;
    } catch {
      // Corrupt or truncated: null, which reads as withheld.
    }
    return null;
  }

  return {
    readOne: (participantId) => readFile(filePathFor(ensureDir(), participantId)),

    write(record): void {
      const file = filePathFor(ensureDir(), record.participantId);
      const temporary = `${file}.${process.pid}${TEMP_FILE_EXT}`;
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, file);
    },

    remove(participantId): boolean {
      const dataDir = ensureDir();
      const file = filePathFor(dataDir, participantId);
      const existed = existsSync(file);
      if (existed) unlinkSync(file);
      // Sweep temp files a crashed write left behind: they carry the record and
      // the participant asked for it gone.
      const tempPrefix = `${consentFileId(participantId)}${CONSENT_FILE_EXT}`;
      for (const entry of readdirSync(dataDir)) {
        if (!entry.startsWith(tempPrefix) || !entry.endsWith(TEMP_FILE_EXT)) continue;
        unlinkSync(path.join(dataDir, entry));
      }
      return existed;
    },

    listIds(): readonly string[] {
      const dataDir = ensureDir();
      const ids: string[] = [];
      // Directory order, not a sort: this module owns no comparator.
      for (const entry of readdirSync(dataDir)) {
        if (!entry.endsWith(CONSENT_FILE_EXT)) continue;
        const record = readFile(path.join(dataDir, entry));
        if (record !== null) ids.push(record.participantId);
      }
      return ids;
    },
  };
}

function createMemoryRepository(): ConsentRepository {
  const records = new Map<string, StoredConsent>();
  return {
    readOne: (participantId) => records.get(participantId) ?? null,
    write: (record) => {
      records.set(record.participantId, record);
    },
    remove: (participantId) => records.delete(participantId),
    listIds: () => Array.from(records.keys()),
  };
}

export function createFileShadowStudyConsentStore(
  options?: ShadowStudyConsentStoreOptions,
): ShadowStudyConsentStore {
  return createStore(createFileRepository(() => options?.dataDir ?? defaultDataDir()));
}

export function createInMemoryShadowStudyConsentStore(): ShadowStudyConsentStore {
  return createStore(createMemoryRepository());
}
