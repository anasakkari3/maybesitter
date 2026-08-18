#!/usr/bin/env node
/**
 * Seals data/registry/priority-seed-set.lock.json: recomputes the locked-split
 * checksum for the active row and every append-only chain checksum, then prints
 * the chain head — the single value a reviewer pins when approving a lock
 * change.
 *
 * Mirrors scripts/seal-lock-ledger.mjs, and inherits its warning: run this after
 * APPENDING a supersession row. Running it after EDITING an existing row will
 * happily reseal the tampered file. That is what code review and the chain head
 * recorded on the authorizing issue are there to catch — the chain makes an
 * in-place edit *visible*, not impossible.
 *
 * `--init` writes a first row for a lock file that does not exist yet.
 *
 * Usage:
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-seed-lock-seal.mjs [--check] [--init]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeChain } from '../lib/evaluation/registry/lockChain.ts';
import { computeLockedSplitChecksum } from '../lib/priority/rubric/seedSetLock.ts';
import { PRIORITY_SEED_PAIRS, RUBRIC_VERSION, lockedSplitPairs } from '../tests/fixtures/prioritySeedSet.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = path.join(repoRoot, 'data/registry/priority-seed-set.lock.json');

const checkOnly = process.argv.includes('--check');
const init = process.argv.includes('--init');

const locked = lockedSplitPairs(PRIORITY_SEED_PAIRS);

const ledger =
  existsSync(LOCK_PATH) && !init
    ? JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
    : {
        contractVersion: '1.0.0',
        records: [
          {
            splitId: 'priority-seed-set-locked-v1',
            rubricVersion: RUBRIC_VERSION,
            pairIds: locked.map((pair) => pair.pairId),
            pairCount: locked.length,
            checksum: computeLockedSplitChecksum(PRIORITY_SEED_PAIRS),
            lockedAt: '2026-08-18T00:00:00.000Z',
            lockedBy: 'model-data track',
            authorizingIssue: 'https://github.com/anasakkari3/maybesitter/issues/19',
            state: 'active',
            supersededBy: null,
            supersessionIssue: null,
            supersessionReason: null,
          },
        ],
      };

// Only the active row is re-fingerprinted. A superseded row records what the
// split *was*; recomputing it would erase the history the chain exists to keep.
const refingerprinted = ledger.records.map((record) =>
  record.state === 'active'
    ? {
        ...record,
        pairIds: locked.map((pair) => pair.pairId),
        pairCount: locked.length,
        checksum: computeLockedSplitChecksum(PRIORITY_SEED_PAIRS),
      }
    : record,
);

const chain = computeChain(refingerprinted.map(({ chainChecksum, ...record }) => record));
const sealed = {
  ...ledger,
  records: refingerprinted.map((record, index) => ({ ...record, chainChecksum: chain[index] })),
};

const serialized = `${JSON.stringify(sealed, null, 2)}\n`;
const head = chain.length === 0 ? '(empty)' : chain[chain.length - 1].value;

if (checkOnly) {
  const current = existsSync(LOCK_PATH) ? readFileSync(LOCK_PATH, 'utf8') : '';
  if (serialized !== current) {
    console.error('Priority seed-set lock is not sealed. Run without --check to reseal.');
    process.exitCode = 1;
  } else {
    console.log(`Priority seed-set lock is sealed. Chain head: ${head}`);
  }
} else {
  writeFileSync(LOCK_PATH, serialized);
  console.log(`Sealed ${locked.length} locked pairs. Chain head: ${head}`);
}
