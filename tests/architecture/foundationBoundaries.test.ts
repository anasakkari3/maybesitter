import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const SOURCE_ROOTS = ['src', 'lib'];

function walk(dir: string): readonly string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

function sourceFiles(): readonly string[] {
  return SOURCE_ROOTS.flatMap((dir) => walk(join(ROOT, dir)));
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function matches(pattern: RegExp): readonly string[] {
  const found: string[] = [];
  for (const file of sourceFiles()) {
    if (pattern.test(read(file))) found.push(relative(ROOT, file));
  }
  return found.sort();
}

test('there is one canonical planner entry point', () => {
  assert.deepEqual(matches(/\bexport function schedulePlan\b/), [
    'lib/planning/scheduler/scheduler.ts',
  ]);
});

test('there is one canonical runtime memory contract and storage implementation', () => {
  assert.deepEqual(matches(/\bexport interface RuntimeMemoryStore\b/), [
    'src/contracts/v1/memoryContracts.ts',
  ]);
  assert.deepEqual(matches(/\bexport class StorageRuntimeMemoryStore\b/), [
    'lib/runtimeMemory/runtimeMemoryStore.ts',
  ]);
  assert.deepEqual(matches(/\bexport function createStorageRuntimeMemoryStore\b/), [
    'lib/runtimeMemory/runtimeMemoryStore.ts',
  ]);
});

test('provider names do not couple directly to planner internals', () => {
  const plannerFiles = sourceFiles().filter((file) => {
    const rel = relative(ROOT, file);
    return rel.startsWith('lib/planning/scheduler/') || rel.startsWith('lib/planning/constraints/');
  });
  const providerPattern = /\b(healthkit|health_connect|whoop|todoist|notion|gmail|outlook|microsoft_graph|rescuetime)\b/i;
  const coupled = plannerFiles
    .filter((file) => providerPattern.test(read(file)))
    .map((file) => relative(ROOT, file));

  assert.deepEqual(coupled, []);
});

test('provider adapters cannot introduce a private planner or memory store by name', () => {
  const providerLikeFiles = sourceFiles().filter((file) => {
    const rel = relative(ROOT, file).toLowerCase();
    return /(provider|adapter|integration|oauth|mcp|whoop|todoist|notion|gmail|outlook|microsoft|healthkit|healthconnect)/.test(rel);
  });

  const duplicateSystemPattern =
    /\b(class|interface|function)\s+(WhoopPlanner|HealthKitPlanner|HealthConnectPlanner|GmailPlanner|TodoistPlanner|NotionPlanner|MicrosoftPlanner|ProviderMemoryStore|IntegrationMemoryStore)\b/;
  const duplicates = providerLikeFiles
    .filter((file) => duplicateSystemPattern.test(read(file)))
    .map((file) => relative(ROOT, file));

  assert.deepEqual(duplicates, []);
});
