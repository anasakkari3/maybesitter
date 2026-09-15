#!/usr/bin/env node
// `npm test` is an explicit file list, not a glob, so a new test file runs
// only once someone adds it there. This check lists every tracked
// tests/**/*.test.ts that `npm test` does not run and that is not documented
// below as belonging to another script. Empty output means every test runs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Test files deliberately run only by a dedicated script, with that script's name. */
export const SCRIPT_ONLY = {
  // Next-step baseline/product contracts: the contract gate, run by `npm run test:contracts`.
  'tests/contract/nextStepBaseline.test.ts': 'test:contracts',
  'tests/contract/nextStepProduct.test.ts': 'test:contracts',
  // Wall-clock bound on the safety gate. Fails under CPU load, so it is not in
  // `npm test`; run `npm run test:perf` on an idle machine (UC-0.3, #136).
  'tests/perf/safetyGateBound.perf.test.ts': 'test:perf',
  // Cost bounds on `validateDecomposition` and on evidence-graph cycle
  // detection. Both defects waste time inside their own index arrays and change
  // neither the verdict nor the number of times the caller's data is read, so
  // there is nothing to count and a clock is the only instrument. Not in
  // `npm test` for the same reason as the line above; run `npm run test:perf`
  // on an idle machine (#380).
  'tests/perf/decompositionValidatorBounds.perf.test.ts': 'test:perf',
  'tests/perf/evidenceGraphBounds.perf.test.ts': 'test:perf',
};

export function registrationProblems(root = process.cwd()) {
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
  const inScript = (name, file) => (scripts[name] ?? '').split(/\s+/).includes(file);
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
  for (const file of tracked) {
    if (inScript('test', file)) continue;
    // `*.emulator.test.ts` needs a running Firestore emulator, so it cannot be
    // in `npm test`. It is covered by `npm run test:emulator`, which matches
    // them by pattern rather than by name; the guard still bites, because a
    // pattern that stopped covering them would leave them unowned here.
    if (file.endsWith('.emulator.test.ts')) {
      if (expandScript('test:emulator').includes('*.emulator.test.ts')) continue;
      problems.push(`${file} is an emulator test but test:emulator does not run *.emulator.test.ts`);
      continue;
    }
    const owner = SCRIPT_ONLY[file];
    if (owner && inScript(owner, file)) continue;
    problems.push(owner ? `${file} is documented as ${owner}-only but ${owner} does not run it` : `${file} is not in npm test`);
  }
  for (const file of scripts.test.split(/\s+/).filter((token) => token.startsWith('tests/'))) {
    if (!tracked.includes(file)) problems.push(`${file} is in npm test but is not a tracked file`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = registrationProblems();
  for (const problem of problems) console.log(problem);
  process.exit(problems.length ? 1 : 0);
}
