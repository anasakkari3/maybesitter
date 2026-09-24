#!/usr/bin/env node
// `npm test` is an explicit file list, not a glob, so a new test file runs
// only once someone adds it there, and CI runs `npm test` and nothing else from
// this list. This check reports, one line each:
//
//   - a tracked tests/**/*.test.ts that `npm test` does not run;
//   - a test file named by any `test:*` script that `npm test` does not run,
//     or that is not a tracked file at all;
//   - a file in SCRIPT_ONLY below whose entry is stale or has no reason;
//   - a `test:serial` that keeps its own file list again (#376).
//
// A test may stay out of `npm test` only as an emulator test (matched by
// pattern, see below) or as an entry in SCRIPT_ONLY with the script that runs it
// and the reason it cannot be in `npm test`. Empty output means every test runs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test files deliberately kept out of `npm test`: the one script that runs each
 * of them, and why it cannot be `npm test`.
 *
 * Being in a narrower script is never a reason on its own. `test:contracts`
 * once ran two files that `npm test` did not, one of them failed on main for a
 * week, and CI never saw it (#376).
 */
export const SCRIPT_ONLY = {
  'tests/perf/safetyGateBound.perf.test.ts': {
    script: 'test:perf',
    reason: 'Wall-clock bound on the safety gate; fails under CPU load, so run on an idle machine (UC-0.3, #136).',
  },
  'tests/perf/decompositionValidatorBounds.perf.test.ts': {
    script: 'test:perf',
    reason: 'Cost bound on `validateDecomposition`. The defect wastes time inside its own index arrays and changes neither the verdict nor how often the caller\'s data is read, so a clock is the only instrument (#380).',
  },
  'tests/perf/evidenceGraphBounds.perf.test.ts': {
    script: 'test:perf',
    reason: 'Cost bound on evidence-graph cycle detection; clock-only for the same reason as the line above (#380).',
  },
  'tests/perf/captureSplitBounds.perf.test.ts': {
    script: 'test:perf',
    reason: 'Wall-clock bound on the capture connector split at the enforced maximum capture length. Its segments are pinned by tests/security/captureInputLimit.test.ts in `npm test`; only the timing lives here (#508).',
  },
};

/** A token in a script that names one test file (not a glob). */
const isTestFileToken = (token) => /\.test\.[cm]?[jt]sx?$/.test(token) && !/[*?]/.test(token);

export function registrationProblems(root = process.cwd()) {
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
  const filesOf = (name) => (scripts[name] ?? '').split(/\s+/).filter(isTestFileToken);
  const npmTest = new Set(filesOf('test'));
  const testScripts = Object.keys(scripts).filter((name) => name.startsWith('test:'));
  /** The `test:*` scripts that name `file`, for the message. */
  const namedBy = (file) => testScripts.filter((name) => filesOf(name).includes(file));
  /**
   * A script's text with whatever it delegates to spliced in. `test:emulator`
   * starts the emulators and hands the file pattern to `test:emulator:attach`,
   * so that CI can run the same pattern against emulators it started itself.
   * Reading only the outer script would report every emulator test as unowned.
   */
  const expandScript = (name, seen = new Set()) => {
    if (seen.has(name)) return '';
    seen.add(name);
    return (scripts[name] ?? '').replace(
      /npm run (?:-s )?([\w:-]+)/g,
      (reference, target) => `${reference} ${expandScript(target, seen)}`,
    );
  };
  const tracked = execFileSync('git', ['ls-files', 'tests'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.test.ts'));

  const problems = [];
  /** Why `file` may be out of `npm test`, or the problem if it may not. */
  const outsideNpmTest = (file) => {
    // `*.emulator.test.ts` needs a running Firestore emulator, so it cannot be
    // in `npm test`. It is covered by `npm run test:emulator`, which matches
    // them by pattern rather than by name; the guard still bites, because a
    // pattern that stopped covering them would leave them unowned here.
    if (file.endsWith('.emulator.test.ts')) {
      if (expandScript('test:emulator').includes('*.emulator.test.ts')) return null;
      return `${file} is an emulator test but test:emulator does not run *.emulator.test.ts`;
    }
    const entry = SCRIPT_ONLY[file];
    if (entry) {
      if (!filesOf(entry.script).includes(file)) return `${file} is documented as ${entry.script}-only but ${entry.script} does not run it`;
      return null;
    }
    const others = namedBy(file);
    return others.length
      ? `${file} is not in npm test, which is the only list CI runs; it runs only in ${others.join(', ')}. Register it in "test", or add it to SCRIPT_ONLY in scripts/check-test-registration.mjs with the reason it cannot be there`
      : `${file} is not in npm test`;
  };

  for (const file of tracked) {
    if (npmTest.has(file)) continue;
    const problem = outsideNpmTest(file);
    if (problem) problems.push(problem);
  }

  // Every test file any `test:*` script names, including ones outside tests/
  // that the loop above cannot see. A name that is not a tracked file is a
  // script that fails before it tests anything, or tests something that is
  // not committed.
  const referenced = [...new Set([...npmTest, ...testScripts.flatMap(filesOf)])];
  const trackedReferenced = new Set(
    execFileSync('git', ['ls-files', '--', ...referenced], { cwd: root, encoding: 'utf8' }).split('\n'),
  );
  for (const file of referenced) {
    if (!trackedReferenced.has(file)) {
      const where = [...(npmTest.has(file) ? ['npm test'] : []), ...namedBy(file)];
      problems.push(`${file} is in ${where.join(', ')} but is not a tracked file`);
      continue;
    }
    if (npmTest.has(file) || tracked.includes(file)) continue;
    const problem = outsideNpmTest(file);
    if (problem) problems.push(problem);
  }

  for (const [file, entry] of Object.entries(SCRIPT_ONLY)) {
    if (typeof entry?.reason !== 'string' || !entry.reason.trim()) {
      problems.push(`${file} is in SCRIPT_ONLY without a reason`);
    }
    if (npmTest.has(file)) {
      problems.push(`${file} is in npm test, so its SCRIPT_ONLY entry is stale; remove it`);
    }
  }

  // `test:serial` is `npm test` one file at a time, derived by
  // scripts/run-test-serial.mjs. A second hand-kept list is what #376 removed:
  // it had drifted to 257 of 429 files and named one that no longer existed.
  if (filesOf('test:serial').length) {
    problems.push('test:serial names test files; it must derive its list from "test" (node scripts/run-test-serial.mjs), not keep a copy (#376)');
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = registrationProblems();
  for (const problem of problems) console.log(problem);
  process.exit(problems.length ? 1 : 0);
}
