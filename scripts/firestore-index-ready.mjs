#!/usr/bin/env node
// Firestore composite-index gate for the deploy workflow (Phase 5.2).
//
//   node scripts/firestore-index-ready.mjs validate <indexes.json>
//   node scripts/firestore-index-ready.mjs wait <database> <timeout-minutes>
//
// `validate` checks the file's shape and touches nothing else.
// `wait` lists the database's composite indexes and exits 0 only when every
// index the file declares is READY. Firestore accepts an index before it is
// built, so "deployed" is not enough: a query that needs a CREATING index fails
// until the build finishes. The gate never deletes anything. Indexes the
// database has but the file does not are reported and left in place, which
// matches `firebase deploy` without --force.
//
// The matching is pure, and it is what the tests exercise. The two commands
// call gcloud and need the deployer's credentials, so they run in CI only.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SCOPES = new Set(['COLLECTION', 'COLLECTION_GROUP']);
const ORDERS = new Set(['ASCENDING', 'DESCENDING']);
const ARRAY_CONFIGS = new Set(['CONTAINS']);

/** Shape errors in a firestore.indexes.json document. An empty list means valid. */
export function validateIndexFile(document) {
  const errors = [];
  if (!document || typeof document !== 'object' || !Array.isArray(document.indexes)) {
    return ['the file has no "indexes" array'];
  }
  const seen = new Set();
  document.indexes.forEach((index, at) => {
    const where = `indexes[${at}]`;
    if (typeof index.collectionGroup !== 'string' || index.collectionGroup === '') errors.push(`${where}: no collectionGroup`);
    if (!SCOPES.has(index.queryScope)) errors.push(`${where}: queryScope must be COLLECTION or COLLECTION_GROUP`);
    if (!Array.isArray(index.fields) || index.fields.length === 0) {
      errors.push(`${where}: no fields`);
    } else {
      for (const [fat, field] of index.fields.entries()) {
        if (typeof field.fieldPath !== 'string' || field.fieldPath === '') errors.push(`${where}.fields[${fat}]: no fieldPath`);
        const hasOrder = ORDERS.has(field.order);
        const hasArray = ARRAY_CONFIGS.has(field.arrayConfig);
        if (hasOrder === hasArray) errors.push(`${where}.fields[${fat}]: needs exactly one of order or arrayConfig`);
      }
    }
    const key = indexKey(index);
    if (seen.has(key)) errors.push(`${where}: duplicates an earlier index`);
    seen.add(key);
  });
  return errors;
}

/** The identity of an index: scope, collection group, and its fields in order. */
export function indexKey(index) {
  const fields = (index.fields ?? []).filter(field => field.fieldPath !== '__name__')
    .map(field => `${field.fieldPath}:${field.order ?? field.arrayConfig ?? ''}`);
  return `${index.queryScope}|${index.collectionGroup}|${fields.join(',')}`;
}

/** Collection group from a Firestore index resource name. */
export function collectionGroupOf(name) {
  const match = /\/collectionGroups\/([^/]+)\/indexes\//.exec(name ?? '');
  return match ? match[1] : '';
}

/**
 * Compares the file's indexes with the database's. `missing` are declared but
 * absent; `creating` are present but not READY; `extra` are on the database and
 * not in the file (never deleted). `ready` means nothing is missing or creating.
 */
export function compareIndexes(declared, remote) {
  const remoteByKey = new Map();
  for (const index of remote) {
    const normalized = { queryScope: index.queryScope, collectionGroup: collectionGroupOf(index.name), fields: index.fields };
    const key = indexKey(normalized);
    if (!remoteByKey.has(key)) remoteByKey.set(key, []);
    remoteByKey.get(key).push(index);
  }
  const declaredKeys = new Set(declared.map(indexKey));
  const missing = [];
  const creating = [];
  for (const index of declared) {
    const matches = remoteByKey.get(indexKey(index)) ?? [];
    if (matches.length === 0) missing.push(indexKey(index));
    else if (!matches.some(match => match.state === 'READY')) creating.push(indexKey(index));
  }
  const extra = [...remoteByKey.keys()].filter(key => !declaredKeys.has(key));
  return { ready: missing.length === 0 && creating.length === 0, missing, creating, extra };
}

function listRemote(database, project) {
  const out = execFileSync('gcloud', [
    'firestore', 'indexes', 'composite', 'list', `--database=${database}`, `--project=${project}`, '--format=json',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'validate') {
    const [path] = rest;
    const errors = validateIndexFile(JSON.parse(readFileSync(path, 'utf8')));
    if (errors.length > 0) {
      for (const error of errors) console.error(`index file: ${error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`index file ok: ${path}`);
    return;
  }
  if (command === 'wait') {
    const [database, minutesText] = rest;
    const project = process.env.PROJECT_ID;
    if (!database || !project) throw new Error('wait needs a database name and PROJECT_ID');
    const minutes = Number(minutesText);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('wait needs a positive timeout in minutes');
    const declared = JSON.parse(readFileSync(process.env.INDEX_FILE ?? 'firestore.indexes.json', 'utf8')).indexes;
    const deadline = Date.now() + minutes * 60_000;
    for (;;) {
      const result = compareIndexes(declared, listRemote(database, project));
      if (result.extra.length > 0) console.log(`not in the file, left in place: ${result.extra.length}`);
      if (result.ready) {
        console.log(`all ${declared.length} declared indexes are READY on ${database}`);
        return;
      }
      console.log(`waiting on ${database}: missing ${result.missing.length}, creating ${result.creating.length}`);
      if (Date.now() >= deadline) {
        console.error(`indexes were not READY within ${minutes} minutes; refusing to route traffic`);
        for (const key of [...result.missing, ...result.creating]) console.error(`  ${key}`);
        process.exitCode = 1;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 30_000));
    }
  }
  console.error('usage: firestore-index-ready.mjs validate <file> | wait <database> <minutes>');
  process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
