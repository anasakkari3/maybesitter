/**
 * Personalization consent store (Sprint 10, issue #42).
 *
 * The one piece of personalization state that persists. The profile itself is
 * forbidden to (`PERSONALIZATION_PERSISTENCE_POLICY.profileCanPersist` is
 * false), which is exactly why "disable takes effect immediately" is cheap:
 * the consent record is the only stored input a flip has to change, and the
 * next derivation reads it fresh.
 *
 * Fail-closed on every unreadable path, per
 * `PERSONALIZATION_INPUT_POLICY.unreadableConsentIsDisabled`: a scope never
 * written, a corrupt file, an unrecognised state, or a file whose stored
 * scopeId disagrees with the requested one all read as
 * `{ state: 'disabled', changedAt: null }` — the default state, which is the
 * opt-in cohort's starting point.
 *
 * Follows lib/feedback/feedbackEventStore.ts structurally: one semantics
 * implementation over a persistence seam, scope ids hashed before they touch
 * the filesystem, temp-then-rename writes at mode 0600, and no ambient clock —
 * every instant is the caller's.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PERSONALIZATION_CONSENT_STATES,
  isInstant,
  type PersonalizationConsent,
  type PersonalizationConsentState,
} from '../../src/contracts/v1/personalizationContracts';
import { isNonEmptyString } from '../evaluation/registry/validationPrimitives';

const CONSENT_SUBDIR = 'personalization-consent';
const CONSENT_FILE_EXT = '.consent.json';
const TEMP_FILE_EXT = '.tmp';
const CONSENT_ID_PREFIX = 'cst_';
const CONSENT_SCHEMA_VERSION = 'personalization-consent-v1' as const;

export interface PersonalizationConsentStore {
  /** Never throws for a readable scopeId: unreadable state is disabled state. */
  read(scopeId: string): PersonalizationConsent;
  write(scopeId: string, state: PersonalizationConsentState, at: string): PersonalizationConsent;
  /** Removes the stored record, returning the scope to the default. 1 or 0. */
  deleteScope(scopeId: string): number;
}

export interface PersonalizationConsentStoreOptions {
  readonly dataDir?: string;
}

interface StoredConsent {
  readonly version: typeof CONSENT_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly state: PersonalizationConsentState;
  readonly changedAt: string;
}

const DISABLED_DEFAULT: PersonalizationConsent = Object.freeze({ state: 'disabled', changedAt: null });

function fail(message: string): never {
  throw new Error(`personalization consent: ${message}`);
}

/** Scope ids are caller text, so they are hashed before naming a file. */
function consentFileId(scopeId: string): string {
  return `${CONSENT_ID_PREFIX}${createHash('sha256').update(scopeId, 'utf8').digest('hex')}`;
}

function isStoredConsent(value: unknown): value is StoredConsent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.version === CONSENT_SCHEMA_VERSION
    && isNonEmptyString(raw.scopeId)
    && (PERSONALIZATION_CONSENT_STATES as readonly unknown[]).includes(raw.state)
    && isInstant(raw.changedAt);
}

interface ConsentRepository {
  readOne(scopeId: string): StoredConsent | null;
  write(record: StoredConsent): void;
  remove(scopeId: string): boolean;
}

function createStore(repository: ConsentRepository): PersonalizationConsentStore {
  return {
    read(scopeId: string): PersonalizationConsent {
      if (!isNonEmptyString(scopeId)) return DISABLED_DEFAULT;
      const record = repository.readOne(scopeId);
      // Anything short of a well-formed record for this exact scope is the
      // default: fail-closed is the direction the policy names.
      if (record === null || record.scopeId !== scopeId) return DISABLED_DEFAULT;
      return Object.freeze({ state: record.state, changedAt: record.changedAt });
    },

    write(scopeId: string, state: PersonalizationConsentState, at: string): PersonalizationConsent {
      if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
      if (!(PERSONALIZATION_CONSENT_STATES as readonly unknown[]).includes(state)) {
        fail(`state must be one of ${PERSONALIZATION_CONSENT_STATES.join(', ')}`);
      }
      if (!isInstant(at)) fail('at must be an ISO instant with an explicit offset');
      repository.write({ version: CONSENT_SCHEMA_VERSION, scopeId, state, changedAt: at });
      return Object.freeze({ state, changedAt: at });
    },

    deleteScope(scopeId: string): number {
      if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
      return repository.remove(scopeId) ? 1 : 0;
    },
  };
}

/** Default record directory, honouring MAYBESITTER_DATA_DIR like sibling stores. */
function defaultDataDir(): string {
  const root = process.env.MAYBESITTER_DATA_DIR || path.join(process.cwd(), '.maybesitter');
  return path.join(root, CONSENT_SUBDIR);
}

function createFileRepository(resolveDataDir: () => string): ConsentRepository {
  function ensureDir(): string {
    const dataDir = resolveDataDir();
    mkdirSync(dataDir, { recursive: true });
    return dataDir;
  }

  function filePathFor(dataDir: string, scopeId: string): string {
    return path.join(dataDir, `${consentFileId(scopeId)}${CONSENT_FILE_EXT}`);
  }

  return {
    readOne(scopeId: string): StoredConsent | null {
      const file = filePathFor(ensureDir(), scopeId);
      if (!existsSync(file)) return null;
      try {
        const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (isStoredConsent(raw)) return raw;
      } catch {
        // Corrupt or truncated: fall through to null, which reads as disabled.
      }
      return null;
    },

    write(record: StoredConsent): void {
      const file = filePathFor(ensureDir(), record.scopeId);
      const temporary = `${file}.${process.pid}${TEMP_FILE_EXT}`;
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, file);
    },

    remove(scopeId: string): boolean {
      const dataDir = ensureDir();
      const file = filePathFor(dataDir, scopeId);
      const existed = existsSync(file);
      if (existed) unlinkSync(file);
      // Sweep temp files a crashed write left for this scope, as the sibling
      // stores do: they carry the record and the user asked for it gone.
      const tempPrefix = `${consentFileId(scopeId)}${CONSENT_FILE_EXT}`;
      for (const entry of readdirSync(dataDir)) {
        if (!entry.startsWith(tempPrefix) || !entry.endsWith(TEMP_FILE_EXT)) continue;
        unlinkSync(path.join(dataDir, entry));
      }
      return existed;
    },
  };
}

function createMemoryRepository(): ConsentRepository {
  const records = new Map<string, StoredConsent>();
  return {
    readOne: (scopeId) => records.get(scopeId) ?? null,
    write: (record) => {
      records.set(record.scopeId, record);
    },
    remove: (scopeId) => records.delete(scopeId),
  };
}

export function createFilePersonalizationConsentStore(
  options?: PersonalizationConsentStoreOptions,
): PersonalizationConsentStore {
  return createStore(createFileRepository(() => options?.dataDir ?? defaultDataDir()));
}

export function createInMemoryPersonalizationConsentStore(): PersonalizationConsentStore {
  return createStore(createMemoryRepository());
}
