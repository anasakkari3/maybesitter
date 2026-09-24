import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registrationProblems } from '../../scripts/check-test-registration.mjs';

// npm test is an explicit file list. Seven tests/memory files sat outside it
// from August to September 2026 and nobody noticed; this keeps that from
// happening again.
test('every tracked test file runs in npm test or its documented script', () => {
  assert.deepEqual(registrationProblems(), []);
});

/** A throwaway git checkout with these tracked test files and these scripts. */
function checkout(files: string[], scripts: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'registration-'));
  mkdirSync(join(root, 'tests'));
  for (const file of files) writeFileSync(join(root, file), '');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

// #376: tests/contract/nextStepBaseline.test.ts ran only in `test:contracts`,
// failed there, and CI, which runs `npm test`, never saw it.
test('a test file that only a narrower test:* script runs is a problem', () => {
  const root = checkout(['tests/a.test.ts', 'tests/b.test.ts'], {
    test: 'node --test tests/a.test.ts',
    'test:contracts': 'node --test tests/a.test.ts tests/b.test.ts',
  });
  try {
    const problems = registrationProblems(root);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /^tests\/b\.test\.ts is not in npm test.*runs only in test:contracts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a test:* script naming a file that is not tracked is a problem', () => {
  const root = checkout(['tests/a.test.ts'], {
    test: 'node --test tests/a.test.ts',
    'test:sprint99': 'node --test tests/a.test.ts tests/moved.test.ts',
  });
  try {
    assert.deepEqual(registrationProblems(root), ['tests/moved.test.ts is in test:sprint99 but is not a tracked file']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('test:serial may not keep a file list of its own again', () => {
  const root = checkout(['tests/a.test.ts'], {
    test: 'node --test tests/a.test.ts',
    'test:serial': 'node --test --test-concurrency=1 tests/a.test.ts',
  });
  try {
    const problems = registrationProblems(root);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /^test:serial names test files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
