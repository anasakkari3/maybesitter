#!/usr/bin/env node
// `npm run test:serial`: exactly the `npm test` command, file list included,
// with one test file at a time. The command is read from package.json on every
// run, so there is no second list to fall behind. The hand-written list this
// replaces had lost 170 of the files `npm test` runs and named one that no
// longer existed (#376).
//
// Why a script and not `npm test -- --test-concurrency=1`: npm appends that
// flag after the file list, and node reads its own options only before the
// first file. On node 24 the trailing flag is dropped without a word and the
// files still run in parallel. NODE_OPTIONS refuses `--test-concurrency`
// outright. So the flag has to go inside the command, before the files.
//
// Extra arguments go in the same place, e.g.
// `npm run test:serial -- --test-name-pattern=deletion`.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The argv (after `node`) that runs `testScript` with `--test-concurrency=1`
 * and `extra` inserted right after `--test`, ahead of every file.
 *
 * The script is split on whitespace and spawned without a shell, so it refuses
 * anything a shell would have read differently (quotes, globs, variables,
 * redirection, command chaining) rather than quietly running something else.
 */
export function serialArgv(testScript, extra = []) {
  if (/["'`$*?&|;<>\\(){}\[\]]/.test(testScript)) {
    throw new Error('the "test" script uses shell syntax; the serial runner only knows a plain `node ... --test <files>` command');
  }
  const tokens = testScript.trim().split(/\s+/);
  if (tokens[0] !== 'node') throw new Error('the "test" script does not start with `node`');
  const at = tokens.indexOf('--test');
  if (at === -1) throw new Error('the "test" script has no `--test` flag');
  if (tokens.some((token) => token.startsWith('--test-concurrency'))) {
    throw new Error('the "test" script already sets --test-concurrency; the serial runner would contradict it');
  }
  return [...tokens.slice(1, at + 1), '--test-concurrency=1', ...extra, ...tokens.slice(at + 1)];
}

// realpath: import.meta.url is resolved through symlinks and argv[1] is not
// (macOS keeps its temp dir behind one).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
  const result = spawnSync(process.execPath, serialArgv(scripts.test, process.argv.slice(2)), {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
}
