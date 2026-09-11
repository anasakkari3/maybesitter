import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  ESCALATION_ENV_VAR,
  ESCALATION_NOT_READY_MESSAGE,
  resolveArbiter,
} from '../../src/extraction/escalationConfig';

// Two-model escalation is merged as primitives but its verdict is NOT READY.
// These tests keep it off: no arbiter by default, a loud refusal when someone
// flips the switch, and no production code handing an arbiter to extraction
// behind resolveArbiter's back.

test('escalation is off when the switch is unset, empty or "off"', () => {
  assert.equal(resolveArbiter({}), undefined);
  assert.equal(resolveArbiter({ [ESCALATION_ENV_VAR]: '' }), undefined);
  assert.equal(resolveArbiter({ [ESCALATION_ENV_VAR]: 'off' }), undefined);
});

test('turning escalation on refuses instead of escalating', () => {
  assert.throws(() => resolveArbiter({ [ESCALATION_ENV_VAR]: 'on' }), {
    message: ESCALATION_NOT_READY_MESSAGE,
  });
  assert.match(ESCALATION_NOT_READY_MESSAGE, /NOT READY/);
});

function typeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...typeScriptFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

test('no production code outside src/extraction passes an arbiter', () => {
  const root = process.cwd();
  const extractionDir = join(root, 'src', 'extraction') + sep;
  const offenders = ['src', 'lib']
    .flatMap((dir) => typeScriptFiles(join(root, dir)))
    .filter((file) => !file.startsWith(extractionDir))
    .filter((file) => /\barbiter\s*:/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file));
  assert.deepEqual(offenders, [], 'escalation must be wired only through resolveArbiter');
});
