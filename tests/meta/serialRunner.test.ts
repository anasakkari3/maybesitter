import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialArgv } from '../../scripts/run-test-serial.mjs';

// `test:serial` used to be a second hand-kept copy of the `npm test` list. By
// #376 it ran 257 of 429 files and named one that had moved, and nothing ran
// it. It is now derived from "test" on every run; these pin that.

const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
const files = (argv: string[]) => argv.filter((token) => token.endsWith('.test.ts'));

test('test:serial runs the npm test command, not a list of its own', () => {
  assert.equal(scripts['test:serial'], 'node scripts/run-test-serial.mjs');
});

test('the serial argv is the npm test argv, same files in the same order, one at a time', () => {
  const testArgv = scripts.test.trim().split(/\s+/).slice(1);
  const argv = serialArgv(scripts.test);
  assert.ok(files(testArgv).length > 400, 'the npm test list looks truncated');
  assert.deepEqual(files(argv), files(testArgv));
  // Everything else is unchanged: the only difference is the one flag.
  assert.deepEqual(argv.filter((token) => token !== '--test-concurrency=1'), testArgv);
  // node reads its options only before the first file; a flag after the list
  // is dropped silently, which is why `npm test -- --test-concurrency=1` is not
  // a serial run.
  const flag = argv.indexOf('--test-concurrency=1');
  assert.ok(flag > argv.indexOf('--test') && flag < argv.indexOf(files(argv)[0]));
});

test('extra arguments land before the files, where node reads them', () => {
  const argv = serialArgv('node --test a.test.ts b.test.ts', ['--test-name-pattern=x']);
  assert.deepEqual(argv, ['--test', '--test-concurrency=1', '--test-name-pattern=x', 'a.test.ts', 'b.test.ts']);
});

test('the serial runner refuses a "test" script it cannot reproduce without a shell', () => {
  assert.throws(() => serialArgv('node --test tests/**/*.test.ts'), /shell syntax/);
  assert.throws(() => serialArgv('FOO=1 node --test a.test.ts'), /does not start with `node`/);
  assert.throws(() => serialArgv('node --test a.test.ts && echo done'), /shell syntax/);
  assert.throws(() => serialArgv('node a.test.ts'), /no `--test` flag/);
  assert.throws(() => serialArgv('node --test --test-concurrency=4 a.test.ts'), /already sets --test-concurrency/);
});

test('the runner really runs one file at a time', () => {
  // The real script, run against a package.json of three probe files that each
  // log when they start and finish. At concurrency 1 no two intervals overlap,
  // however busy the machine is.
  const root = mkdtempSync(join(tmpdir(), 'serial-runner-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync('scripts/run-test-serial.mjs', join(root, 'scripts', 'run-test-serial.mjs'));
    const log = join(root, 'log.txt');
    const names = ['a', 'b', 'c'];
    for (const name of names) {
      writeFileSync(join(root, `${name}.test.mjs`), [
        "import { test } from 'node:test';",
        "import { appendFileSync } from 'node:fs';",
        `test('${name}', async () => {`,
        '  const start = Date.now();',
        '  await new Promise((resolve) => setTimeout(resolve, 150));',
        `  appendFileSync(${JSON.stringify(log)}, \`${name} \${start} \${Date.now()}\\n\`);`,
        '});',
      ].join('\n'));
    }
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      scripts: { test: `node --test ${names.map((name) => `${name}.test.mjs`).join(' ')}` },
    }));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'run-test-serial.mjs')], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const runs = readFileSync(log, 'utf8').trim().split('\n')
      .map((line) => line.split(' '))
      .map(([name, start, end]) => ({ name, start: Number(start), end: Number(end) }))
      .sort((left, right) => left.start - right.start);
    assert.deepEqual(runs.map((run) => run.name).sort(), names);
    for (let index = 1; index < runs.length; index += 1) {
      assert.ok(runs[index].start >= runs[index - 1].end, `${runs[index - 1].name} and ${runs[index].name} overlapped`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
