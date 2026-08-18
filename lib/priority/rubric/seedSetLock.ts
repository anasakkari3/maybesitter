/**
 * Checksum lock for the held-out Priority evaluation split
 * (Sprint 04, issue #19).
 *
 * The locked split is what an eventual annotation run is measured against, so
 * editing a locked pair after judgments exist would silently change what those
 * judgments refer to — the judgment would still say `left`, but `left` would be
 * a different commitment. That is not a cosmetic drift: it is a measurement
 * quietly re-pointed at something else.
 *
 * This deliberately **reuses** the existing lock idiom in
 * lib/evaluation/registry/** rather than inventing a second one:
 *
 *  - the same `checksumOf(canonicalJson(...))` fingerprint, so key order and
 *    incidental whitespace cannot change a checksum;
 *  - the same append-only chain (`computeChain`), so a ledger row cannot be
 *    rewritten in place to match an edited split. A checksum alone is not
 *    enough — anyone who can edit the split can also edit the row that pins it.
 *    Each row commits to every row before it, so the only consistent way to
 *    change a locked split is to append a supersession row, which is visible in
 *    review.
 *
 * The lock lives in its own file (`data/registry/priority-seed-set.lock.json`)
 * rather than in `data/registry/dataset-registry.json`, because the seed set is
 * an in-repo TypeScript corpus rather than a materialised dataset artifact with
 * a repository/revision/path, and forcing it into that shape would mean
 * fabricating location fields.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Checksum, LockState, ValidationResult } from '../../evaluation/registry/contracts';
import { canonicalJson, checksumOf } from '../../evaluation/registry/fingerprint';
import { computeChain } from '../../evaluation/registry/lockChain';
import {
  IssueCollector,
  checksumsEqual,
  isIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
  isValidChecksum,
} from '../../evaluation/registry/validationPrimitives';
import {
  PRIORITY_SEED_PAIRS,
  RUBRIC_VERSION,
  lockedSplitPairs,
  type PrioritySeedPair,
} from '../../../tests/fixtures/prioritySeedSet';

export const SEED_SET_LOCK_CONTRACT_VERSION = '1.0.0';

export const SEED_SET_LOCK_PATH = fileURLToPath(
  new URL('../../../data/registry/priority-seed-set.lock.json', import.meta.url),
);

/* ── Shape ──────────────────────────────────────────────────────── */

export interface SeedSetLockRecord {
  /** Identity of the split *version*, not of the seed set. A change appends a new one. */
  splitId: string;
  rubricVersion: string;
  pairIds: string[];
  pairCount: number;
  checksum: Checksum;
  lockedAt: string;
  lockedBy: string;
  authorizingIssue: string;
  state: LockState;
  supersededBy: string | null;
  supersessionIssue: string | null;
  supersessionReason: string | null;
  /** Commits to this row and every row before it. See lib/evaluation/registry/lockChain.ts. */
  chainChecksum: Checksum;
}

export interface SeedSetLockLedger {
  contractVersion: string;
  records: SeedSetLockRecord[];
}

/* ── Fingerprint ────────────────────────────────────────────────── */

/**
 * Fingerprints the locked split by content.
 *
 * Filters and sorts internally so the checksum is a function of the *set*: a
 * reordering of the declarations in the seed set is not a change to the split,
 * and would otherwise force a spurious supersession.
 */
export function computeLockedSplitChecksum(pairs: readonly PrioritySeedPair[]): Checksum {
  const locked = pairs
    .filter((pair) => pair.split === 'locked')
    .slice()
    .sort((a, b) => (a.pairId < b.pairId ? -1 : a.pairId > b.pairId ? 1 : 0));
  return checksumOf(canonicalJson(locked));
}

/** Recomputes every chain checksum, so a ledger is sealed by construction. */
export function sealSeedSetLock(ledger: {
  contractVersion: string;
  records: readonly (Omit<SeedSetLockRecord, 'chainChecksum'> & { chainChecksum?: Checksum })[];
}): SeedSetLockLedger {
  const stripped = ledger.records.map(({ chainChecksum: _ignored, ...record }) => record);
  const chain = computeChain(stripped as never);
  return {
    contractVersion: ledger.contractVersion,
    records: stripped.map((record, index) => ({ ...record, chainChecksum: chain[index] }) as SeedSetLockRecord),
  };
}

/* ── Reading and parsing ────────────────────────────────────────── */

export function readSeedSetLock(path: string = SEED_SET_LOCK_PATH): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export interface SeedSetLockParseResult extends ValidationResult {
  lock: SeedSetLockLedger | null;
}

export function parseSeedSetLock(raw: unknown): SeedSetLockParseResult {
  const collector = new IssueCollector();

  if (!isPlainObject(raw)) {
    collector.error('PSL001', 'lock', 'seed-set lock must be an object');
    return { ...collector.result(), lock: null };
  }
  if (raw.contractVersion !== SEED_SET_LOCK_CONTRACT_VERSION) {
    collector.error(
      'PSL002',
      'lock.contractVersion',
      `expected '${SEED_SET_LOCK_CONTRACT_VERSION}', found ${JSON.stringify(raw.contractVersion)}`,
    );
  }
  if (!Array.isArray(raw.records) || raw.records.length === 0) {
    collector.error('PSL003', 'lock.records', 'records must be a non-empty array');
    return { ...collector.result(), lock: null };
  }

  const splitIds = new Set<string>();
  raw.records.forEach((record, index) => {
    const path = `lock.records[${index}]`;
    if (!isPlainObject(record)) {
      collector.error('PSL010', path, 'record must be an object');
      return;
    }
    if (!isNonEmptyString(record.splitId)) collector.error('PSL011', `${path}.splitId`, 'splitId is required');
    else if (splitIds.has(record.splitId)) {
      collector.error('PSL012', `${path}.splitId`, `duplicate splitId '${record.splitId}'`);
    } else splitIds.add(record.splitId);

    if (!isNonEmptyString(record.rubricVersion)) {
      collector.error('PSL013', `${path}.rubricVersion`, 'rubricVersion is required');
    }
    if (!Array.isArray(record.pairIds) || record.pairIds.some((id) => !isNonEmptyString(id))) {
      collector.error('PSL014', `${path}.pairIds`, 'pairIds must be an array of non-empty strings');
    }
    if (!isValidChecksum(record.checksum)) collector.error('PSL015', `${path}.checksum`, 'checksum must be sha256 hex');
    if (!isValidChecksum(record.chainChecksum)) {
      collector.error('PSL016', `${path}.chainChecksum`, 'chainChecksum must be sha256 hex');
    }
    if (!isIsoTimestamp(record.lockedAt)) collector.error('PSL017', `${path}.lockedAt`, 'lockedAt must be ISO-8601');
    if (!isNonEmptyString(record.lockedBy)) collector.error('PSL018', `${path}.lockedBy`, 'lockedBy is required');
    if (!isNonEmptyString(record.authorizingIssue)) {
      collector.error('PSL019', `${path}.authorizingIssue`, 'authorizingIssue is required');
    }
    if (record.state !== 'active' && record.state !== 'superseded') {
      collector.error('PSL010', `${path}.state`, "state must be 'active' or 'superseded'");
    }
    if (record.state === 'superseded' && !isNonEmptyString(record.supersededBy)) {
      collector.error('PSL022', `${path}.supersededBy`, 'a superseded row must name what supersedes it');
    }
  });

  const result = collector.result();
  return { ...result, lock: result.valid ? (raw as unknown as SeedSetLockLedger) : null };
}

/* ── Verification ───────────────────────────────────────────────── */

/**
 * Verifies that the committed lock still describes the committed split.
 *
 * Checks in this order, because each later check is only meaningful if the
 * earlier ones hold: shape, then the append-only chain, then the single active
 * row, then membership, then content.
 */
export function verifySeedSetLock(options?: {
  pairs?: readonly PrioritySeedPair[];
  lock?: SeedSetLockLedger;
}): ValidationResult {
  const pairs = options?.pairs ?? PRIORITY_SEED_PAIRS;
  const collector = new IssueCollector();

  const parsed = options?.lock ? { valid: true, issues: [], lock: options.lock } : parseSeedSetLock(readSeedSetLock());
  collector.merge(parsed.issues);
  const lock = parsed.lock;
  if (!lock) return collector.result();

  // The chain first: without it, a checksum match proves only that the file and
  // the split agree, which anyone editing both can arrange.
  const expected = computeChain(lock.records.map(({ chainChecksum: _ignored, ...record }) => record) as never);
  lock.records.forEach((record, index) => {
    if (!checksumsEqual(record.chainChecksum, expected[index])) {
      collector.error(
        'PSL040',
        `lock.records[${index}].chainChecksum`,
        `chain checksum does not match the sealed history; the ledger is append-only and row ${index} ` +
          'appears to have been rewritten in place',
      );
    }
  });

  const active = lock.records.filter((record) => record.state === 'active');
  if (active.length === 0) {
    collector.error(
      'PSL020',
      'lock.records',
      'no active lock row: the evaluation split would be unprotected, which is not a state the lock may reach silently',
    );
    return collector.result();
  }
  if (active.length > 1) {
    collector.error('PSL021', 'lock.records', `${active.length} active lock rows; exactly one may be active`);
    return collector.result();
  }

  const record = active[0];
  const locked = lockedSplitPairs(pairs);
  const currentIds = locked.map((pair) => pair.pairId);

  if (record.rubricVersion !== RUBRIC_VERSION) {
    collector.error(
      'PSL032',
      'lock.records[active].rubricVersion',
      `lock was sealed under rubric '${record.rubricVersion}' but the current rubric is '${RUBRIC_VERSION}'; ` +
        'judgments are not comparable across rubric versions, so the split needs a new lock row',
    );
  }
  if (record.pairIds.join(',') !== currentIds.join(',')) {
    collector.error(
      'PSL031',
      'lock.records[active].pairIds',
      `locked split membership changed: sealed [${record.pairIds.join(', ')}], found [${currentIds.join(', ')}]`,
    );
  }
  if (record.pairCount !== currentIds.length) {
    collector.error(
      'PSL033',
      'lock.records[active].pairCount',
      `sealed pairCount ${record.pairCount} but the split holds ${currentIds.length} pairs`,
    );
  }

  const observed = computeLockedSplitChecksum(pairs);
  if (!checksumsEqual(record.checksum, observed)) {
    collector.error(
      'PSL030',
      'lock.records[active].checksum',
      `locked split content changed: sealed ${record.checksum.value}, found ${observed.value}`,
    );
  }

  return collector.result();
}
