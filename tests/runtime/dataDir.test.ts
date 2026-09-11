import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { localDataDir, resolveDataDir } from '../../lib/runtime/dataDir';

function withDataDirEnv(value: string | undefined, run: () => void): void {
  const original = process.env.MAYBESITTER_DATA_DIR;
  try {
    if (value === undefined) delete process.env.MAYBESITTER_DATA_DIR;
    else process.env.MAYBESITTER_DATA_DIR = value;
    run();
  } finally {
    if (original === undefined) delete process.env.MAYBESITTER_DATA_DIR;
    else process.env.MAYBESITTER_DATA_DIR = original;
  }
}

// Production runs with the env var unset. Every store that moved onto
// resolveDataDir must land exactly where its hard-coded default used to.
test('resolveDataDir defaults to <cwd>/.maybesitter when MAYBESITTER_DATA_DIR is unset', () => {
  withDataDirEnv(undefined, () => {
    assert.equal(resolveDataDir(), join(process.cwd(), '.maybesitter'));
    assert.equal(resolveDataDir('alpha-traces'), join(process.cwd(), '.maybesitter', 'alpha-traces'));
    assert.equal(resolveDataDir('domain-state.json'), join(process.cwd(), '.maybesitter', 'domain-state.json'));
  });
});

test('an empty MAYBESITTER_DATA_DIR is treated as unset', () => {
  withDataDirEnv('', () => {
    assert.equal(resolveDataDir('clarifications.json'), join(process.cwd(), '.maybesitter', 'clarifications.json'));
  });
});

test('resolveDataDir follows MAYBESITTER_DATA_DIR, read at call time', () => {
  withDataDirEnv('/srv/maybesitter-data', () => {
    assert.equal(resolveDataDir(), '/srv/maybesitter-data');
    assert.equal(resolveDataDir('alpha-feedback', 'x.flag.json'), join('/srv/maybesitter-data', 'alpha-feedback', 'x.flag.json'));
  });
});

test('localDataDir ignores MAYBESITTER_DATA_DIR, so the pilot check can compare against it', () => {
  withDataDirEnv('/srv/maybesitter-data', () => {
    assert.equal(localDataDir(), join(process.cwd(), '.maybesitter'));
  });
});
