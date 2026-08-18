/**
 * Storage for reviewed Priority decisions (Sprint 05, issue #21).
 *
 * ── One implementation, two backends ────────────────────────────────
 *
 * Everything semantic — validation, append-only-ness, duplicate refusal,
 * conflict detection — lives in `createStore()` above the `DecisionRepository`
 * seam, and the two backends differ only in persistence. This is the shape
 * lib/runtimeMemory/runtimeMemoryStore.ts uses, adopted for the same reason: the
 * sibling alpha stores duplicated their logic per backend and their in-memory
 * `prune()` drifted into a no-op. A test store that behaves differently from a
 * production store is a test that proves nothing about production.
 *
 * ── Append-only, and why disagreement is never resolved here ────────
 *
 * A decision is never overwritten and never merged. Two reviewers who disagree
 * on a pair produce two rows and a `DecisionConflict`; there is no code path
 * that averages them and none that lets the later write win. That is not
 * fastidiousness about immutability: disagreement usually means the rubric is
 * ambiguous at that pair, which is a fact about the rubric, and a collapsed row
 * would destroy it precisely where it is most informative. Sprint 04 made the
 * same call for `unresolved` in the agreement report.
 *
 * `unresolved` is likewise *not* treated as disagreement, following that same
 * report: an abstention is neither agreement nor disagreement. Counting it as a
 * conflict would penalise a reviewer for correctly following the rubric's
 * abstention rules, which pushes them to guess — converting honest abstention
 * into fabricated preference, the exact failure this track exists to prevent.
 * The row is still stored and still visible; it simply does not manufacture a
 * conflict that nobody expressed.
 *
 * ── Ids reach the filesystem ────────────────────────────────────────
 *
 * Decision ids are caller-supplied (a reviewer tool picks them) and become
 * `<decisionId>.decision.json`, so `DECISION_ID_PATTERN` is the only thing
 * between an imported file and a path traversal. Anything failing it cannot name
 * a decision this store wrote, so refusing it loses nothing.
 *
 * ── Deletion reaches further than reading ───────────────────────────
 *
 * `deleteReviewer` sweeps `.tmp` files left by a crashed write and files too
 * damaged to parse, because both still hold the reviewer's text. Reading skips
 * them; deleting must not. Two real gaps of exactly this kind were found in the
 * runtime memory store. A file too damaged to name *any* owner is left in place:
 * deleting unattributable files on any reviewer deletion could destroy another
 * reviewer's work.
 *
 * No function here reads the system clock; `decidedAt` and `exportedAt` are
 * supplied.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { JudgmentVerdict } from '../../../src/contracts/v1/priorityContracts';
import {
  CALIBRATION_SCHEMA_VERSION,
  type DecisionConflict,
  type JudgmentProvenance,
  type ReviewedDecision,
} from '../../../src/contracts/v1/calibrationContracts';
import { isNonEmptyString } from '../../evaluation/registry/validationPrimitives';
import {
  createReviewedDecision,
  isReviewedDecision,
  toSafeDecisionId,
  type CreateDecisionInput,
} from './reviewedDecision';

export const DECISION_STORE_SUBDIR = 'priority-annotation';
export const DECISION_FILE_EXT = '.decision.json';
/** Suffix of a temp file written before the atomic rename. */
const TEMP_FILE_EXT = '.tmp';

function fail(message: string): never {
  throw new Error(`annotation decision store: ${message}`);
}

/** Code-unit ordering, never localeCompare: listings feed committed reports. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A corpus of decisions as it travels between processes or into review.
 *
 * `provenance` is on the corpus rather than inferred, so a reader of a stored
 * file can tell whether they are holding reviewer evidence or a pipeline proof.
 * Weights fitted to judgments nobody made look exactly like weights fitted to
 * real ones, so the distinction cannot rest on the discipline of whoever ran it.
 */
export interface ReviewedDecisionCorpus {
  readonly contractVersion: typeof CALIBRATION_SCHEMA_VERSION;
  readonly provenance: JudgmentProvenance;
  readonly rubricVersion: string;
  readonly exportedAt: string;
  readonly decisions: readonly ReviewedDecision[];
}

export interface DecisionStore {
  /** Validates, refuses duplicates, and never overwrites. Throws on any of those. */
  append(input: CreateDecisionInput): ReviewedDecision;
  get(decisionId: string): ReviewedDecision | null;
  list(): readonly ReviewedDecision[];
  listByPair(pairId: string): readonly ReviewedDecision[];
  listByReviewer(reviewerId: string): readonly ReviewedDecision[];
  /** Retained disagreements, computed from the stored rows rather than cached. */
  conflicts(): readonly DecisionConflict[];
  remove(decisionId: string): boolean;
  /** Removes every artifact attributable to a reviewer, parseable or not. */
  deleteReviewer(reviewerId: string): number;
  export(options: { exportedAt: string; provenance: JudgmentProvenance; rubricVersion: string }): ReviewedDecisionCorpus;
}

export interface DecisionStoreOptions {
  /** Overrides the leaf directory outright, as the sibling stores do. */
  readonly dataDir?: string;
}

/**
 * Persistence seam. Everything above this line is shared by both backends, so
 * append-only-ness and conflict retention cannot diverge between them.
 */
interface DecisionRepository {
  readOne(decisionId: string): ReviewedDecision | null;
  readAll(): ReviewedDecision[];
  write(decision: ReviewedDecision): void;
  remove(decisionId: string): boolean;
  /**
   * Removes every stored artifact attributable to the reviewer, including any
   * the reader cannot parse. Only the backend knows what it is holding, so it
   * does the sweep.
   */
  removeReviewer(reviewerId: string): number;
}

/**
 * Groups stored rows into retained conflicts.
 *
 * Exported so #22 and the coverage report derive conflicts the same way rather
 * than each inventing a rule.
 */
export function detectDecisionConflicts(
  decisions: readonly ReviewedDecision[],
): readonly DecisionConflict[] {
  const byPair = new Map<string, ReviewedDecision[]>();
  for (const decision of decisions) {
    // Abstentions drop out here, and only here — the same single point of
    // exclusion the Sprint 04 agreement report uses.
    if (decision.verdict === 'unresolved') continue;
    const bucket = byPair.get(decision.pairId);
    if (bucket) bucket.push(decision);
    else byPair.set(decision.pairId, [decision]);
  }

  const conflicts: DecisionConflict[] = [];
  for (const pairId of Array.from(byPair.keys()).sort(byCodeUnit)) {
    const rows = (byPair.get(pairId) ?? []).slice().sort((a, b) => byCodeUnit(a.decisionId, b.decisionId));
    const reviewers = new Set(rows.map((row) => row.reviewerId));
    const verdicts = new Set(rows.map((row) => row.verdict));
    if (reviewers.size < 2 || verdicts.size < 2) continue;
    conflicts.push(
      Object.freeze({
        pairId,
        // Parallel arrays: decisionIds[i] carries verdicts[i]. The committed
        // contract has no reviewer field here, so a consumer that needs to know
        // *who* disagreed joins back on decisionId.
        decisionIds: Object.freeze(rows.map((row) => row.decisionId)),
        verdicts: Object.freeze(rows.map((row) => row.verdict)) as readonly JudgmentVerdict[],
      }),
    );
  }
  return Object.freeze(conflicts);
}

function createStore(repository: DecisionRepository): DecisionStore {
  function readSafe(decisionId: unknown): ReviewedDecision | null {
    const safeId = toSafeDecisionId(decisionId);
    return safeId === null ? null : repository.readOne(safeId);
  }

  function all(): ReviewedDecision[] {
    return repository.readAll().slice().sort((a, b) => byCodeUnit(a.decisionId, b.decisionId));
  }

  return {
    append(input: CreateDecisionInput): ReviewedDecision {
      // Construction validates provenance and never spreads the input, so a
      // forged `version` or a missing reviewerId cannot reach storage.
      const decision = createReviewedDecision(input);

      if (repository.readOne(decision.decisionId) !== null) {
        fail(
          `'${decision.decisionId}' already exists; the store is append-only so a correction is a new ` +
            'row, not an overwrite',
        );
      }
      const priorFromSameReviewer = repository
        .readAll()
        .find((row) => row.pairId === decision.pairId && row.reviewerId === decision.reviewerId);
      if (priorFromSameReviewer) {
        fail(
          `reviewer '${decision.reviewerId}' already decided pair '${decision.pairId}' ` +
            `as '${priorFromSameReviewer.decisionId}'; a second decision under a different id would be ` +
            'last-write-wins wearing two row ids',
        );
      }

      repository.write(decision);
      return decision;
    },

    get(decisionId: string): ReviewedDecision | null {
      return readSafe(decisionId);
    },

    list(): readonly ReviewedDecision[] {
      return Object.freeze(all());
    },

    listByPair(pairId: string): readonly ReviewedDecision[] {
      if (!isNonEmptyString(pairId)) fail('pairId must be a non-empty string');
      return Object.freeze(all().filter((decision) => decision.pairId === pairId));
    },

    listByReviewer(reviewerId: string): readonly ReviewedDecision[] {
      if (!isNonEmptyString(reviewerId)) fail('reviewerId must be a non-empty string');
      return Object.freeze(all().filter((decision) => decision.reviewerId === reviewerId));
    },

    conflicts(): readonly DecisionConflict[] {
      return detectDecisionConflicts(all());
    },

    remove(decisionId: string): boolean {
      const safeId = toSafeDecisionId(decisionId);
      return safeId === null ? false : repository.remove(safeId);
    },

    deleteReviewer(reviewerId: string): number {
      if (!isNonEmptyString(reviewerId)) fail('reviewerId must be a non-empty string');
      return repository.removeReviewer(reviewerId);
    },

    export(options): ReviewedDecisionCorpus {
      if (!isNonEmptyString(options?.exportedAt)) fail('exportedAt must be supplied; the store reads no clock');
      if (options.provenance !== 'human_reviewed' && options.provenance !== 'synthetic_pipeline_proof') {
        fail("provenance must be 'human_reviewed' or 'synthetic_pipeline_proof'");
      }
      if (!isNonEmptyString(options.rubricVersion)) fail('rubricVersion must be a non-empty string');
      return Object.freeze({
        contractVersion: CALIBRATION_SCHEMA_VERSION,
        provenance: options.provenance,
        rubricVersion: options.rubricVersion,
        exportedAt: options.exportedAt,
        decisions: Object.freeze(all()),
      });
    },
  };
}

/* ── Backends ───────────────────────────────────────────────────── */

function defaultDataDir(): string {
  const root = process.env.MAYBESITTER_DATA_DIR || path.join(process.cwd(), '.maybesitter');
  return path.join(root, DECISION_STORE_SUBDIR);
}

function createFileRepository(resolveDataDir: () => string): DecisionRepository {
  function ensureDir(): string {
    const dataDir = resolveDataDir();
    mkdirSync(dataDir, { recursive: true });
    return dataDir;
  }

  function decisionPath(dataDir: string, decisionId: string): string {
    return path.join(dataDir, `${decisionId}${DECISION_FILE_EXT}`);
  }

  function readFile(filePath: string): ReviewedDecision | null {
    try {
      const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      if (isReviewedDecision(raw)) return Object.freeze(raw);
    } catch {
      // Corrupt, truncated, or written by another schema version — skip it
      // rather than failing the whole read, so one bad file cannot deny access
      // to every other decision in the corpus.
    }
    return null;
  }

  /**
   * Lenient attribution for deletion only. Enough of a file may survive to say
   * whose it is even when it fails the record guard, and that is exactly the
   * file a reviewer deletion must not miss.
   */
  function readReviewerId(filePath: string): string | null {
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
    try {
      const raw = JSON.parse(text) as Record<string, unknown> | null;
      if (typeof raw?.reviewerId === 'string') return raw.reviewerId;
    } catch {
      // Fall through: the likeliest corruption is a write truncated by a crash,
      // and reviewerId sits near the top of the row, so the owner's name usually
      // survives even when the JSON does not.
    }
    const match = /"reviewerId"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (!match) return null;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return null;
    }
  }

  return {
    readOne(decisionId: string): ReviewedDecision | null {
      const filePath = decisionPath(ensureDir(), decisionId);
      return existsSync(filePath) ? readFile(filePath) : null;
    },

    readAll(): ReviewedDecision[] {
      const dataDir = ensureDir();
      const decisions: ReviewedDecision[] = [];
      for (const entry of readdirSync(dataDir)) {
        if (!entry.endsWith(DECISION_FILE_EXT)) continue;
        const decision = readFile(path.join(dataDir, entry));
        if (decision) decisions.push(decision);
      }
      return decisions;
    },

    write(decision: ReviewedDecision): void {
      const filePath = decisionPath(ensureDir(), decision.decisionId);
      // Temp-then-rename so a reader never observes a half-written decision.
      // 0600 because a rationale is a named person's own words.
      const temporary = `${filePath}.${process.pid}${TEMP_FILE_EXT}`;
      writeFileSync(temporary, `${JSON.stringify(decision, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, filePath);
    },

    remove(decisionId: string): boolean {
      const dataDir = ensureDir();
      const filePath = decisionPath(dataDir, decisionId);
      const existed = existsSync(filePath);
      if (existed) unlinkSync(filePath);

      // Sweep any temp file a crashed write left for this same id. Nothing else
      // reaches it afterwards — readAll() skips `.tmp` — and it holds the
      // complete row, rationale included.
      const tempPrefix = `${decisionId}${DECISION_FILE_EXT}`;
      for (const entry of readdirSync(dataDir)) {
        if (!entry.startsWith(tempPrefix) || !entry.endsWith(TEMP_FILE_EXT)) continue;
        unlinkSync(path.join(dataDir, entry));
      }
      return existed;
    },

    removeReviewer(reviewerId: string): number {
      const dataDir = ensureDir();
      let removed = 0;
      for (const entry of readdirSync(dataDir)) {
        if (!entry.endsWith(DECISION_FILE_EXT) && !entry.endsWith(TEMP_FILE_EXT)) continue;
        const filePath = path.join(dataDir, entry);
        // Only an exact match deletes. A file too damaged to name any owner is
        // left in place: destroying unattributable files on one reviewer's
        // deletion could destroy a different reviewer's work, and that residue
        // is an operator problem rather than one this call may resolve.
        if (readReviewerId(filePath) !== reviewerId) continue;
        unlinkSync(filePath);
        removed++;
      }
      return removed;
    },
  };
}

function createMemoryRepository(): DecisionRepository {
  const decisions = new Map<string, ReviewedDecision>();
  return {
    readOne: (decisionId) => decisions.get(decisionId) ?? null,
    readAll: () => Array.from(decisions.values()),
    write: (decision) => {
      decisions.set(decision.decisionId, decision);
    },
    remove: (decisionId) => decisions.delete(decisionId),
    removeReviewer: (reviewerId) => {
      let removed = 0;
      for (const entry of Array.from(decisions.entries())) {
        if (entry[1].reviewerId === reviewerId && decisions.delete(entry[0])) removed++;
      }
      return removed;
    },
  };
}

/**
 * File-backed store, one JSON file per decision under
 * `<MAYBESITTER_DATA_DIR|cwd/.maybesitter>/priority-annotation/<id>.decision.json`.
 * The directory is resolved per call, so a test may set the env var after
 * constructing the store.
 */
export function createFileDecisionStore(options?: DecisionStoreOptions): DecisionStore {
  return createStore(createFileRepository(() => options?.dataDir ?? defaultDataDir()));
}

/** In-memory store with identical semantics, for tests and ephemeral use. */
export function createInMemoryDecisionStore(): DecisionStore {
  return createStore(createMemoryRepository());
}
