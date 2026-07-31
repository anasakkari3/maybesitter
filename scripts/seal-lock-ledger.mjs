#!/usr/bin/env node
/**
 * Recomputes the append-only chain checksums in
 * data/registry/locked-artifacts.ledger.json and prints the resulting chain
 * head, which is the single value a reviewer pins when approving a lock change.
 *
 * Run this after APPENDING a row. Running it after EDITING an existing row will
 * happily reseal the tampered ledger — that is exactly what code review and the
 * chain head recorded on the authorizing issue are there to catch.
 *
 * Usage:
 *   node --loader ./scripts/ts-resolver.mjs scripts/seal-lock-ledger.mjs [--check]
 *
 * --check does not write; it exits non-zero if the file is not already sealed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeChain } from '../lib/evaluation/registry/lockChain.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_PATH = path.join(repoRoot, 'data/registry/locked-artifacts.ledger.json');

const checkOnly = process.argv.includes('--check');
const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
const chain = computeChain(ledger.records);

const sealed = {
  ...ledger,
  records: ledger.records.map((record, index) => ({ ...record, chainChecksum: chain[index] })),
};

const serialized = `${JSON.stringify(sealed, null, 2)}\n`;
const current = readFileSync(LEDGER_PATH, 'utf8');
const head = chain.length === 0 ? '(empty)' : chain[chain.length - 1].value;

if (checkOnly) {
  if (serialized !== current) {
    console.error('lock ledger is not sealed; run scripts/seal-lock-ledger.mjs');
    process.exit(1);
  }
  console.log(`lock ledger sealed, chain head ${head}`);
  process.exit(0);
}

writeFileSync(LEDGER_PATH, serialized, 'utf8');
console.log(`sealed ${ledger.records.length} record(s), chain head ${head}`);
