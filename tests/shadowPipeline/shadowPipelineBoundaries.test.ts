/**
 * The half of "shadow results cannot mutate canonical state" that no type can
 * check.
 *
 * `shadowPipelineContracts` makes a shadow *outcome* structurally inert:
 * `SHADOW_OUTCOME_INERTNESS` fails to compile if any field of it becomes
 * callable, and `checkShadowInertness` reports a callable that arrives through
 * an untyped boundary. Both are claims about the value the pipeline returns.
 * Neither says anything about the *callee* — `SHADOW_WRITE_SURFACE` records
 * that honestly as `moduleAdapterMayReachIO: true` — and an adapter that called
 * `createFileRuntimeMemoryStore` would write files while returning a perfectly
 * inert object.
 *
 * That is what this file closes. It walks the adapters' resolved import closure
 * on disk and asserts that nothing reachable from a shadow adapter can write
 * anything: not through a writer service, not through the filesystem, not over
 * a network, not by spawning a process.
 *
 * ── How the scan is built, and the two mistakes it is built around ───────
 *
 *  1. **Matching is on the resolved repo path, never on the specifier text.**
 *     Sprint 06 recorded the cost: a pattern anchored on
 *     `decomposition/(proposal|evaluation)` never saw an import spelled
 *     `../proposal/...`, and went on reporting a clean separation across the
 *     very edge it existed to forbid. The specifier text is used only for the
 *     bare-module checks (`node:fs` has no repo path to resolve to).
 *
 *  2. **Comments are stripped before specifiers are extracted.** This file's
 *     own subject matter is writers and clocks, and the modules in the closure
 *     explain at length why they must not reach them. A raw-text scan cannot
 *     tell an explanation from a violation, and the cheapest way to make it
 *     pass would be to delete the explanation — the wrong direction, and the
 *     same conclusion `planningBoundaries.test.ts` reached for the same reason.
 *     `the scan still recognises a real writer import` pins that the stripper
 *     did not disarm anything.
 *
 *  3. **Whole-clause `import type` edges are erased before the walk**, because
 *     the guarantee is about what can *execute* and TypeScript erases them. The
 *     first run of this suite reported one false positive on exactly that:
 *     `lifeStateContracts` names `DomainState`'s home, `domain/stateMachine`,
 *     in an `import type`. See `eraseTypeOnlyImports`.
 *
 * ── What the scan covers, and what it cannot ─────────────────────────────
 *
 * Covers: every `.ts` file reachable at **runtime** from
 * `lib/shadowPipeline/adapters.ts` by static `import` / `export … from` /
 * `import()` / `require()` — 44 files at the time of writing, spanning six real
 * intelligence modules and the contracts. Type-only edges are excluded because
 * they do not execute; `the closure excludes type-only edges but still reaches
 * every module it wires` keeps that from silently hollowing the walk out.
 *
 * Cannot cover, stated rather than left to be assumed:
 *   - Dynamic specifiers built at runtime (`import(someVariable)`). Nothing in
 *     the closure has one, and `no import specifier in the closure is computed`
 *     asserts that, which is what makes the static walk sufficient here.
 *   - Behaviour reached through an injected dependency. The `ShadowMemoryReader`
 *     the caller supplies is outside the closure by construction — that is the
 *     point of injecting it — so `the memory adapter cannot reach a write
 *     method` in `adapters.test.ts` covers that edge behaviourally instead.
 *   - What a module does to memory or CPU. This is a write guarantee, not a
 *     resource guarantee.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const shadowDir = join(repoRoot, 'lib', 'shadowPipeline');
const adapterRoot = join(shadowDir, 'adapters.ts');
const orchestratorRoot = join(shadowDir, 'orchestrator.ts');
const compositionRoot = join(shadowDir, 'index.ts');

/**
 * Modules that write canonical user state, or hand out something that does.
 *
 * The first six are `planningBoundaries.test.ts`'s list, inherited whole rather
 * than re-derived — a second list of "what counts as a writer" is the Sprint 06
 * duplication in its smallest form. The last two are this module's own:
 * `runtimeMemoryStore` is the registry's named memory entry point and calls
 * `writeFileSync`, and `clarificationStore` is the other store a capture path
 * could plausibly reach for.
 */
const FORBIDDEN_MODULE_BASENAMES = [
  'commandService',
  'deterministicStateGateway',
  'dataStore',
  'behaviorFeedbackService',
  'stateMachine',
  'captureBoundaryService',
  'runtimeMemoryStore',
  'clarificationStore',
] as const;

/**
 * Host capabilities a shadow adapter may not reach for.
 *
 * Stronger than the basename list and the reason this file is worth having: a
 * writer nobody has written yet still needs one of these to write anything.
 * `node:crypto` is deliberately absent — hashing is not writing, and
 * `lib/planning/scheduler/digest.ts` needs it.
 */
const FORBIDDEN_HOST_MODULES = [
  'node:fs',
  'node:fs/promises',
  'fs',
  'fs/promises',
  'node:child_process',
  'child_process',
  'node:net',
  'net',
  'node:http',
  'http',
  'node:https',
  'https',
  'node:dgram',
  'dgram',
  'node:worker_threads',
  'worker_threads',
] as const;

/** Source with comments removed. See the header for why this exists. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Removes whole-clause `import type` / `export type` edges.
 *
 * **The guarantee this file makes is about what can execute**, and a type-only
 * import cannot: TypeScript erases it, so the module on the other end is never
 * evaluated and never gets the chance to write anything. Scanning it anyway
 * produces a false positive, and the first run of this suite produced exactly
 * one — `src/contracts/v1/lifeStateContracts.ts` names `DomainState`'s home,
 * `../../domain/stateMachine`, in an `import type`. Reporting that as a writer
 * edge would have been wrong, and the two ways to make the suite green from
 * there — widening the writer list's exceptions, or deleting the assertion —
 * are both worse than being right about what an erased import is.
 *
 * **Deliberately conservative**: only the whole-clause forms are erased. An
 * inline `import { type Foo, bar }` still emits a runtime import for the
 * module, so it stays scanned, and so does `export { type Foo, bar } from`.
 * Erasing more than TypeScript does would be the direction that hides a real
 * edge. `the type-only eraser removes only what the compiler removes` pins
 * both halves.
 */
function eraseTypeOnlyImports(source: string): string {
  return source
    .replace(/\bimport\s+type\s+[^;]*?from\s*['"][^'"]+['"]\s*;?/g, ' ')
    .replace(/\bexport\s+type\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/g, ' ');
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Side-effect-only imports bind no name but still run the module, which is
    // enough to drag a writer in.
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match !== null) {
      specifiers.push(match[1]);
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) || null;
}

type ReadSource = (file: string) => string;

const readFromDisk: ReadSource = (file) =>
  eraseTypeOnlyImports(stripComments(readFileSync(file, 'utf8')));

/**
 * Every repo file reachable from `roots`, mapped to its own import specifiers.
 *
 * `readSource` is injectable for one reason: `the scan still recognises a real
 * writer import` needs to prove the whole walk — extraction, resolution and the
 * forbidden check — catches an edge that is not actually in the tree. Adding
 * the edge to a real file and deleting it afterwards would leave the repo
 * broken if the test crashed between the two.
 */
function importClosure(
  roots: readonly string[],
  readSource: ReadSource = readFromDisk,
): Map<string, string[]> {
  const closure = new Map<string, string[]>();
  const queue = roots.slice();

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (closure.has(file)) continue;
    const specifiers = importSpecifiers(readSource(file));
    closure.set(file, specifiers);
    for (const specifier of specifiers) {
      const resolved = resolveLocal(file, specifier);
      if (resolved !== null && !closure.has(resolved)) queue.push(resolved);
    }
  }
  return closure;
}

function relative(file: string): string {
  return file.slice(repoRoot.length + 1);
}

/** Every forbidden edge in a closure, as readable strings. Empty means clean. */
function writerViolations(closure: Map<string, string[]>): string[] {
  const violations: string[] = [];
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      const basename = specifier.split('/').pop() as string;
      if ((FORBIDDEN_MODULE_BASENAMES as readonly string[]).includes(basename)) {
        violations.push(`${relative(file)} -> writer module "${specifier}"`);
      }
      if ((FORBIDDEN_HOST_MODULES as readonly string[]).includes(specifier)) {
        violations.push(`${relative(file)} -> host capability "${specifier}"`);
      }
      if (/(^|\/)(app\/api|app\/\(|mobile|components)\//.test(specifier)) {
        violations.push(`${relative(file)} -> surface "${specifier}"`);
      }
      if (/(^|\/)services\//.test(specifier)) {
        violations.push(`${relative(file)} -> product service "${specifier}"`);
      }
    }
  }
  return violations.sort();
}

function shadowSourceFiles(): string[] {
  return readdirSync(shadowDir)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => join(shadowDir, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
}

/* ── The scan is not vacuous ─────────────────────────────────────── */

test('the adapter root exists and the closure is substantial', () => {
  // Without this, every assertion below would walk an empty set and pass by
  // finding nothing — the failure mode where a renamed file turns a suite of
  // structural guards into a suite of tautologies.
  assert.ok(existsSync(adapterRoot), `${relative(adapterRoot)} does not exist`);
  const closure = importClosure([adapterRoot]);
  assert.ok(
    closure.size > 20,
    `the adapter closure is only ${closure.size} files; it should span the real modules`,
  );
  // And it really does reach the modules it claims to wire.
  const reached = Array.from(closure.keys()).map(relative);
  for (const expected of [
    'src/extraction/ruleBasedExtractor.ts',
    'lib/decomposition/engine/index.ts',
    'lib/planning/scheduler/scheduler.ts',
    'lib/recommendation/selector/select.ts',
    'lib/coaching/deliver.ts',
    'lib/safety/gateway.ts',
  ]) {
    assert.ok(reached.includes(expected), `the adapter closure does not reach ${expected}`);
  }
});

test('the closure excludes type-only edges but still reaches every module it wires', () => {
  // Erasing type-only imports shrinks the closure, and a shrinking closure is
  // exactly how a structural guard quietly stops guarding. Both halves: the
  // erasure really removed something, and what remains is still the whole
  // runtime chain.
  const runtime = importClosure([adapterRoot]);
  const withTypes = importClosure([adapterRoot], (file) => stripComments(readFileSync(file, 'utf8')));
  assert.ok(
    withTypes.size > runtime.size,
    'erasing type-only imports removed nothing; the eraser is not doing anything',
  );
  assert.ok(
    runtime.size > 40,
    `the runtime closure is only ${runtime.size} files; the erasure has hollowed the scan out`,
  );
});

test('the closure walks past the first hop, so it is not a direct-import check in disguise', () => {
  const closure = importClosure([adapterRoot]);
  const direct = new Set(
    (closure.get(adapterRoot) ?? [])
      .map((specifier) => resolveLocal(adapterRoot, specifier))
      .filter((resolved): resolved is string => resolved !== null),
  );
  assert.ok(
    Array.from(closure.keys()).some((file) => file !== adapterRoot && !direct.has(file)),
    'the closure reached nothing more than one hop away',
  );
});

test('no import specifier in the closure is computed, so a static walk is sufficient', () => {
  // The scan can only follow literal specifiers. If anything in the closure
  // built one at runtime, the guarantee below would have a hole the scan could
  // not see — so the absence of dynamic specifiers is itself an assertion.
  for (const file of Array.from(importClosure([adapterRoot]).keys())) {
    const source = stripComments(readFileSync(file, 'utf8'));
    assert.equal(
      /import\s*\(\s*[^'")\s]/.test(source),
      false,
      `${relative(file)} builds an import specifier at runtime; the static closure cannot see where it goes`,
    );
  }
});

/* ── The guarantee ───────────────────────────────────────────────── */

test('nothing reachable from a shadow adapter can write anything', () => {
  // The headline acceptance criterion, at the layer the types cannot reach.
  assert.deepEqual(writerViolations(importClosure([adapterRoot])), []);
});

test('nothing reachable from the composition root can write anything either', () => {
  // `index.ts` is the one file that legitimately reaches the host clock and the
  // timer, through `realtime.ts`. It still may not reach a writer, and scanning
  // it is what keeps "the ports live here" from becoming "anything lives here".
  assert.deepEqual(writerViolations(importClosure([compositionRoot])), []);
});

test('nothing reachable from the orchestrator can write anything either', () => {
  // The orchestrator is a separate root: it does not import the adapters (they
  // are passed in), so a violation there would be invisible to the scan above.
  assert.deepEqual(writerViolations(importClosure([orchestratorRoot])), []);
});

test('the adapter closure reaches no filesystem, network or process capability', () => {
  // Stated separately from the writer-module list because it is the stronger
  // claim and the one that survives someone inventing a new writer: a writer
  // nobody has written yet still needs one of these to write anything.
  const closure = importClosure([adapterRoot]);
  const bare = new Set<string>();
  for (const specifiers of Array.from(closure.values())) {
    for (const specifier of specifiers) if (!specifier.startsWith('.')) bare.add(specifier);
  }
  for (const forbidden of FORBIDDEN_HOST_MODULES) {
    assert.equal(bare.has(forbidden), false, `the adapter closure imports ${forbidden}`);
  }
  // `node:crypto` is the one host module the closure legitimately uses —
  // hashing is not writing — and naming it here means its arrival was a
  // decision rather than something the scan happened not to look for.
  assert.deepEqual(
    Array.from(bare).filter((specifier) => specifier.startsWith('node:')).sort(),
    ['node:crypto'],
  );
});

/* ── The scan fails when it should: proved, not assumed ──────────── */

test('the scan still recognises a real writer import', () => {
  // A negative-only assertion passes against a regex that matches nothing and
  // just as well against a stripper that ate the whole file. This adds the edge
  // the guarantee forbids and demands that the whole walk — extraction,
  // resolution, and the forbidden check — reports it.
  //
  // The edge is injected through `readSource` rather than written to disk: a
  // real file edited and deleted around an assertion leaves the repo broken if
  // the assertion throws in between.
  const injected: ReadSource = (file) =>
    file === adapterRoot
      ? `${readFromDisk(file)}\nimport { commandService } from '../services/commandService';`
      : readFromDisk(file);

  const violations = writerViolations(importClosure([adapterRoot], injected));
  assert.ok(
    violations.some((violation) => violation.includes('commandService')),
    'a writer import was added to the adapter root and the scan did not report it',
  );
  // It reports it as both a writer module and a product service, which is
  // correct: it is both, and a scan that fired on only one of two overlapping
  // rules would be one rule short.
  assert.ok(violations.some((violation) => violation.includes('product service')));
});

test('the scan recognises a filesystem import, a surface import, and a store factory', () => {
  // Each rule in `writerViolations` reached from its own probe, so a rule that
  // stopped matching would fail here rather than silently pass everywhere.
  const probes: readonly (readonly [string, string])[] = [
    ['node:fs', 'host capability'],
    ['../../src/app/api/route', 'surface'],
    ['../runtimeMemory/runtimeMemoryStore', 'writer module'],
    ['../services/pressureService', 'product service'],
  ];
  for (const probe of probes) {
    const injected: ReadSource = (file) =>
      file === adapterRoot ? `${readFromDisk(file)}\nimport 'X';`.replace("'X'", `'${probe[0]}'`) : readFromDisk(file);
    const violations = writerViolations(importClosure([adapterRoot], injected));
    assert.ok(
      violations.some((violation) => violation.includes(probe[1])),
      `an import of ${probe[0]} was not reported as a ${probe[1]}`,
    );
  }
});

test('the type-only eraser removes only what the compiler removes', () => {
  // Erased, because TypeScript erases it and the module never evaluates.
  assert.deepEqual(
    importSpecifiers(eraseTypeOnlyImports("import type { DomainState } from '../../domain/stateMachine';")),
    [],
  );
  assert.deepEqual(
    importSpecifiers(eraseTypeOnlyImports("export type { Instant } from './planningContracts';")),
    [],
  );
  // Kept, because these all emit a runtime import — this is the direction that
  // would hide a real writer edge, so it is the direction worth pinning.
  assert.deepEqual(
    importSpecifiers(eraseTypeOnlyImports("import { commandService } from '../services/commandService';")),
    ['../services/commandService'],
  );
  assert.deepEqual(
    importSpecifiers(eraseTypeOnlyImports("import { type Options, run } from '../services/commandService';")),
    ['../services/commandService'],
  );
  assert.deepEqual(
    importSpecifiers(eraseTypeOnlyImports("export { type Options, run } from '../services/commandService';")),
    ['../services/commandService'],
  );
  assert.deepEqual(
    importSpecifiers(eraseTypeOnlyImports("import '../services/commandService';")),
    ['../services/commandService'],
  );
});

test('stripping comments does not disarm the specifier scan', () => {
  // The stripper exists because the closure is full of prose explaining why
  // these modules must not be reached. It must remove the prose and leave the
  // code — both halves, or the guard is either noisy or blind.
  const realImport = "import { commandService } from '../services/commandService';";
  assert.deepEqual(importSpecifiers(stripComments(realImport)), ['../services/commandService']);
  assert.deepEqual(
    importSpecifiers(stripComments("/** never import from '../services/commandService' here */")),
    [],
  );
  assert.deepEqual(importSpecifiers(stripComments("// see '../services/commandService'")), []);
});

/* ── The clock, and its single named exemption ───────────────────── */

/**
 * The one file allowed to read the host clock or arm a timer. Named, so the
 * exemption is a decision a diff shows rather than a pattern that quietly grew.
 */
const CLOCK_EXEMPT = ['lib/shadowPipeline/realtime.ts'];

test('nothing under lib/shadowPipeline reads an ambient clock, except realtime.ts', () => {
  const files = shadowSourceFiles();
  assert.ok(files.length > 0, 'no shadow pipeline sources were scanned');

  for (const file of files) {
    if (CLOCK_EXEMPT.includes(relative(file))) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const rule of [
      [/Date\.now\s*\(/, 'must not call Date.now(); every instant in a shadow run is an input'],
      [/new\s+Date\s*\(\s*\)/, 'must not construct a Date from the ambient clock'],
      [/Math\.random\s*\(/, 'must not use Math.random(); two runs of one seed must agree'],
      [/randomUUID/, 'must not mint ids; two runs of one seed must agree on every id'],
      [/localeCompare/, 'must not order by locale; use compareByCodePoint'],
      [/setTimeout|setInterval/, 'must not arm a timer; the deadline is a port'],
    ] as const) {
      assert.equal(rule[0].test(source), false, `${relative(file)} ${rule[1]}`);
    }
  }
});

test('the clock exemption is real: realtime.ts actually contains the thing it is exempted for', () => {
  // An exemption for a file that does not need one is an exemption nobody
  // revisits, and it is exactly where a second clock would be added later.
  for (const exempt of CLOCK_EXEMPT) {
    const path = join(repoRoot, exempt);
    assert.ok(existsSync(path), `${exempt} is exempted from the clock scan and does not exist`);
    const source = stripComments(readFileSync(path, 'utf8'));
    assert.ok(/new\s+Date\s*\(\s*\)/.test(source), `${exempt} is exempted and reads no clock`);
    assert.ok(/setTimeout/.test(source), `${exempt} is exempted and arms no timer`);
  }
  // And it is small enough for a reviewer to hold at once, which is the whole
  // argument for having exactly one exempt file rather than a pattern.
  const lines = readFileSync(join(repoRoot, CLOCK_EXEMPT[0]), 'utf8').split('\n').length;
  assert.ok(lines < 120, `the exempt file is ${lines} lines; it is meant to be reviewable at a glance`);
});

test('the clock scan still recognises a real clock, a real timer and a real sort', () => {
  const cases: readonly (readonly [RegExp, string])[] = [
    [/Date\.now\s*\(/, 'const at = Date.now();'],
    [/new\s+Date\s*\(\s*\)/, 'const at = new Date();'],
    [/Math\.random\s*\(/, 'const r = Math.random();'],
    [/randomUUID/, 'const id = randomUUID();'],
    [/localeCompare/, 'names.sort((a, b) => a.localeCompare(b));'],
    [/setTimeout|setInterval/, 'setTimeout(fire, 10);'],
  ];
  for (const entry of cases) {
    assert.equal(entry[0].test(entry[1]), true, `pattern no longer matches its own sample: ${entry[1]}`);
    assert.equal(
      entry[0].test(stripComments(entry[1])),
      true,
      `stripComments removed real code for: ${entry[1]}`,
    );
  }
  // And the case that motivates the stripper: prose naming the forbidden call.
  assert.equal(
    /Date\.now\s*\(/.test(stripComments('/** never call Date.now() here */\nconst x = 1;')),
    false,
    'a comment explaining the rule must not read as a violation of it',
  );
  // `new Date(supplied)` is not a clock read, and must survive.
  assert.equal(/new\s+Date\s*\(\s*\)/.test('new Date(seed.now)'), false);
});
