/**
 * Source-scanning boundary tests for lib/decomposition/proposal/**
 * (Sprint 06, issue #25).
 *
 * "The original commitment remains canonical until confirmation" is the
 * acceptance criterion, and no behavioural test can establish it: running the
 * reducer and finding that nothing was written only shows that the writes the
 * test happened to look for did not happen. So this file reads the source and
 * walks the **transitive** import closure, because one hop is enough to drag a
 * writer in — `agendaService` imports `commandService`, so anything importing
 * `agendaService` reaches persistence without ever naming it. That gap was real
 * in this repo; the technique is taken from
 * tests/lifeState/lifeStateBoundaries.test.ts and tests/priority/shadowBoundaries.test.ts.
 *
 * The scanner carries the Sprint 03 fix those files carry: a bare
 * `import 'x';` binds no name, so it has no `from` clause and a
 * `from ['"]...['"]` pattern misses it entirely while the module still executes
 * in full. The `scanner:` tests below check the scanner against synthetic
 * sources rather than trusting that it works, because a scanner that silently
 * sees nothing reports a perfectly clean closure.
 *
 * The last guard is the sharpest: the closure reaches no filesystem or network
 * primitive at all. A writer the ban list has never heard of still needs I/O to
 * persist anything, and there is none here — the confirmed steps leave through
 * an injected port this module only declares.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const proposalDir = join(repoRoot, 'lib', 'decomposition', 'proposal');
const portFile = join(proposalDir, 'persistencePort.ts');

/** Modules that write canonical user state or reach persistence directly. */
const FORBIDDEN_WRITER_BASENAMES = [
  'commandService',
  'deterministicStateGateway',
  'dataStore',
  'agendaService',
  'agendaActionService',
  'behaviorFeedbackService',
  'captureBoundaryService',
  'persistenceAdapter',
] as const;

/**
 * Modules that define or project canonical user state.
 *
 * `stateMachine` is `src/domain/stateMachine.ts`, and it is banned rather than
 * merely unused: the corrected premise for this issue is that the proposal
 * reducer is *not* a domain transition, and an import of the domain machine is
 * how that decision would quietly reverse itself.
 */
const FORBIDDEN_CANONICAL_BASENAMES = [
  'stateMachine',
  'domainAppSnapshotAdapter',
  'lifeStateProjection',
] as const;

/** UI surfaces, and the frameworks only a UI surface needs. */
const FORBIDDEN_UI_PATTERNS = [
  /\.tsx$/,
  /(^|\/)src\/components(\/|$)/,
  /(^|\/)src\/app(\/|$)/,
  /(^|\/)src\/context(\/|$)/,
  /(^|\/)app\/api(\/|$)/,
  /(^|\/)mobile(\/|$)/,
  /^react($|\/|-)/,
  /^next($|\/)/,
] as const;

/** I/O of any kind. A reducer and an in-memory map need none of it. */
const FORBIDDEN_IO_SPECIFIERS = [
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'path',
  'node:path',
  'http',
  'node:http',
  'https',
  'node:https',
  'net',
  'node:net',
  'crypto',
  'node:crypto',
] as const;

/**
 * The sibling Sprint 06 tracks. #25, #26 and #27 are built in parallel in
 * separate worktrees and coordinate only through the contracts; an import of
 * one from another is a dependency nobody reviewed.
 */
const FORBIDDEN_SIBLING_PATTERNS = [
  // Matched on the directory segment rather than the full path, because a
  // sibling would be imported from inside lib/decomposition/proposal as
  // `../engine/...` — a pattern anchored on `decomposition/engine` would never
  // see the spelling the violation would actually take.
  /(^|\/)engine(\/|$)/,
  /(^|\/)boundary(\/|$)/,
  /(^|\/)evaluation(\/|$)/,
] as const;

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFilesUnder(full);
      return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : [];
    })
    .sort();
}

/** Every import specifier in a source, in all four spellings. */
export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Side-effect-only `import 'x';` binds no name and so has no `from` clause,
    // yet it executes the module in full. The whitespace after `import` keeps
    // this from matching `import('x')`, which the pattern above already covers.
    /import\s+['"]([^'"]+)['"]/g,
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

/**
 * Import statements the compiler erases: `import type` and `export type`.
 *
 * They bind no runtime value and execute no module, so they cannot reach a
 * writer however forbidden the module at the other end is. Separating them is
 * not a loophole but the difference between "this code can call that" and "this
 * code names that type" — and it is load-bearing, because the frozen contract
 * chain reaches `src/domain/stateMachine` through exactly one such import
 * (`lifeStateContracts.ts` naming `DomainState`) and through no other edge.
 *
 * The pattern is deliberately tight — no quote or semicolon between `type` and
 * the specifier — so it cannot run past the end of a statement and swallow the
 * value import that follows it.
 */
const TYPE_ONLY_PATTERNS = [
  /\b(?:import|export)\s+type\s+[^'";]*from\s*['"]([^'"]+)['"]/g,
] as const;

export function typeOnlySpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of TYPE_ONLY_PATTERNS) {
    let match = pattern.exec(source);
    while (match !== null) {
      specifiers.push(match[1]);
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

/**
 * Specifiers that survive compilation — the only ones that are a real edge.
 *
 * Computed by deleting the erased statements and re-scanning, rather than by
 * subtracting one list from another, so a module imported both as a type and as
 * a value is correctly still a value edge.
 */
export function valueSpecifiers(source: string): string[] {
  return importSpecifiers(
    source.replace(/\b(?:import|export)\s+type\s+[^'";]*from\s*['"][^'"]+['"]/g, ' '),
  );
}

/**
 * Source with its comments removed.
 *
 * The content bans below are about what the code *does*, and these modules
 * explain in prose why they read no clock. Scanning raw text would flag those
 * explanations, and the cheapest way to make such a scanner green is to delete
 * the comment that states the rule — so the scanner would be pushing the code
 * in the wrong direction. The line-comment pattern keeps the character before
 * `//`, so a `https://` inside a string literal is not read as a comment.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function strippedSource(file: string): string {
  return stripComments(readFileSync(file, 'utf8'));
}

/**
 * The repo file a specifier names, or null when it names no repo file.
 *
 * Understands `@/*`, which `tsconfig.json` maps to `./src/*` and which 76
 * imports across `lib/` and `src/` use. Without it the closure walk stopped
 * dead at the repo's dominant import spelling: an `@/`-reached module was never
 * opened, so everything it imported was invisible — in the one test that is the
 * sole evidence for "the original commitment remains canonical".
 *
 * A non-bare specifier that resolves to nothing throws rather than returning
 * null. Silence is what let the alias hole survive: an edge the scanner chose
 * not to follow and an edge it followed to nothing produced the same clean
 * result, so the closure could shrink to nothing and still report green.
 */
function resolveLocal(fromFile: string, specifier: string): string | null {
  const aliased = specifier.startsWith('@/');
  if (!aliased && !specifier.startsWith('.')) return null;

  const withoutExtension = specifier.replace(/\.tsx?$/, '');
  const base = aliased
    ? join(repoRoot, 'src', withoutExtension.slice(2))
    : resolve(dirname(fromFile), withoutExtension);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.json`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (found) return found;

  throw new Error(
    `boundary scanner: could not resolve "${specifier}" from ${relative(fromFile)}. `
      + 'A specifier the scanner cannot follow is a hole in the closure, not a file to skip.',
  );
}

/** Every repo file reachable from `roots`, mapped to its own import specifiers. */
function importClosure(roots: readonly string[]): Map<string, string[]> {
  const closure = new Map<string, string[]>();
  const queue = roots.slice();

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (closure.has(file)) continue;

    // Stripped, so prose in a doc comment that names a module is not read as an
    // import of it. The content bans below already read stripped source; having
    // the closure read raw meant a comment explaining why a writer is forbidden
    // reported that writer as a violation.
    const specifiers = valueSpecifiers(stripComments(readFileSync(file, 'utf8')));
    closure.set(file, specifiers);

    for (const specifier of specifiers) {
      const resolved = resolveLocal(file, specifier);
      // Only source files are walked further; a .json or .js leaf has no
      // TypeScript imports to follow but is still a legitimate resolution.
      if (resolved && /\.tsx?$/.test(resolved) && !closure.has(resolved)) queue.push(resolved);
    }
  }
  return closure;
}

function basenameOf(specifier: string): string {
  const segments = specifier.split('/');
  return (segments[segments.length - 1] || '').replace(/\.tsx?$/, '');
}

function forbiddenReason(specifier: string): string | null {
  const basename = basenameOf(specifier);
  if ((FORBIDDEN_WRITER_BASENAMES as readonly string[]).includes(basename)) {
    return 'writes canonical user state';
  }
  if ((FORBIDDEN_CANONICAL_BASENAMES as readonly string[]).includes(basename)) {
    return 'defines or projects canonical user state';
  }
  if (FORBIDDEN_UI_PATTERNS.some((pattern) => pattern.test(specifier))) return 'is a UI surface';
  if (FORBIDDEN_SIBLING_PATTERNS.some((pattern) => pattern.test(specifier))) {
    return 'belongs to a sibling Sprint 06 track';
  }
  return null;
}

function relative(file: string): string {
  return file.slice(repoRoot.length + 1);
}

/* ── The scanner itself ───────────────────────────────────────────── */

test('scanner: a bare side-effect import is seen, not silently skipped', () => {
  const source = [
    "import '../../services/commandService';",
    'import   "../../../src/domain/stateMachine";',
    "import { thing } from './thing';",
    "const lazy = await import('./lazy');",
    "const legacy = require('./legacy');",
  ].join('\n');

  const found = importSpecifiers(source);

  assert.ok(found.includes('../../services/commandService'), 'bare single-quoted side-effect import must be found');
  assert.ok(found.includes('../../../src/domain/stateMachine'), 'bare double-quoted side-effect import must be found');
  assert.ok(found.includes('./thing'), 'named import must be found');
  assert.ok(found.includes('./lazy'), 'dynamic import must be found');
  assert.ok(found.includes('./legacy'), 'require must be found');
});

test('scanner: each forbidden category is actually recognised', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['../../services/commandService', 'writes canonical user state'],
    ['../../../src/domain/stateMachine', 'defines or projects canonical user state'],
    ['../../../src/components/AgendaList.tsx', 'is a UI surface'],
    ['react', 'is a UI surface'],
    ['../engine/decompositionEngine', 'belongs to a sibling Sprint 06 track'],
    ['../evaluation/decompositionEvaluator', 'belongs to a sibling Sprint 06 track'],
  ];

  for (const [specifier, expected] of cases) {
    assert.equal(forbiddenReason(specifier), expected, `${specifier} must be recognised`);
  }
  assert.equal(
    forbiddenReason('../../../src/contracts/v1/decompositionContracts'),
    null,
    'the shared contract is the one thing this module is supposed to import',
  );
});

test('scanner: the proposal module exists and is scanned, so these guards are never vacuous', () => {
  const files = sourceFilesUnder(proposalDir);
  assert.ok(files.length > 0, 'expected at least one source file under lib/decomposition/proposal');
  // `proposalStore.ts` and `persistencePort.ts` were named here until the
  // sprint's two confirmation boundaries were consolidated. Both were deleted:
  // #27's store and adapter are the ones with a writer behind them, and a
  // second store over a port nothing implemented was the arrangement that kept
  // producing the same defect twice. What is left in this directory is the pure
  // reducer, which is #25's actual deliverable.
  for (const expected of ['proposalStateMachine.ts']) {
    assert.ok(
      files.some((file) => file.endsWith(expected)),
      `expected ${expected} to be part of the scanned surface`,
    );
  }
  assert.deepEqual(
    files.map((file) => file.slice(proposalDir.length + 1)).sort(),
    ['index.ts', 'proposalStateMachine.ts'],
    'the proposal module is one reducer and its barrel; anything else here is a second confirmation path growing back',
  );
});

test('scanner: the closure walks past the first hop', () => {
  // Without this, the whole file would silently degrade into a direct-import
  // check — which is exactly what a writer reached through one intermediate
  // module slips past.
  //
  // Demonstrated on a real repo file with real depth rather than on the
  // proposal module itself. Since the consolidation deleted the duplicate store,
  // the reducer's only surviving *runtime* edge is the shared connective
  // lexicon — its contract import is `import type` and therefore erased — so
  // its own closure is one hop deep and could no longer show the walk working.
  // That is the guarantee getting stronger, and it must not be allowed to make
  // the scanner's self-test vacuous. The confirmation boundary is the natural
  // stand-in: it reaches the engine at one hop and the engine's own modules at
  // two, which is precisely the shape a writer-behind-an-intermediary takes.
  const root = join(repoRoot, 'lib', 'decomposition', 'boundary', 'decompositionBoundaryService.ts');
  const roots = [root];
  const closure = importClosure(roots);
  const directlyImported = new Set(
    roots.flatMap((file) =>
      valueSpecifiers(stripComments(readFileSync(file, 'utf8')))
        .map((specifier) => resolveLocal(file, specifier))
        .filter((resolved): resolved is string => resolved !== null),
    ),
  );

  assert.ok(
    Array.from(closure.keys()).some((file) => !roots.includes(file) && !directlyImported.has(file)),
    'expected the closure to reach at least one module more than one hop away',
  );
});

test('the proposal module is a leaf: its only runtime dependency is the shared lexicon', () => {
  // The consolidation's own guarantee, stated as a property. Before it, the
  // proposal module carried a store that imported the contract for a runtime
  // constant and a port declaring a persistence seam; now the reducer holds no
  // runtime edge at all except the connective lexicon it must share with #26
  // and #27 so the three cannot disagree about what a connective is. Anything
  // else appearing here is a confirmation path being rebuilt beside the one
  // that writes.
  const closure = importClosure(sourceFilesUnder(proposalDir));
  const external = Array.from(closure.keys())
    .filter((file) => !file.startsWith(`${proposalDir}/`))
    .map(relative)
    .sort();

  assert.deepEqual(external, ['lib/decomposition/shared/connectives.ts']);
});

/* ── The guarantees ───────────────────────────────────────────────── */

test('the proposal module reaches no writer, canonical-state module, UI, or sibling track', () => {
  const roots = sourceFilesUnder(proposalDir);
  const closure = importClosure(roots);
  assert.ok(closure.size >= roots.length, 'import closure should cover every scanned file');

  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      const reason = forbiddenReason(specifier);
      assert.equal(
        reason,
        null,
        `${relative(file)} reaches "${specifier}", which ${reason}; the original commitment stays `
          + 'canonical because there is no path from here to a writer, not because nobody called one',
      );
    }
  }
});

test('the proposal module reaches no filesystem or network primitive at all', () => {
  const closure = importClosure(sourceFilesUnder(proposalDir));

  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      assert.equal(
        (FORBIDDEN_IO_SPECIFIERS as readonly string[]).includes(specifier),
        false,
        `${relative(file)} imports "${specifier}"; confirmed steps leave through the injected port, not through I/O`,
      );
    }
  }

  for (const file of sourceFilesUnder(proposalDir)) {
    const source = strippedSource(file);
    assert.equal(/\bfetch\s*\(/.test(source), false, `${relative(file)} must not call fetch()`);
    assert.equal(/\bprocess\.env\b/.test(source), false, `${relative(file)} must not read process.env`);
    assert.equal(/\bglobalThis\b/.test(source), false, `${relative(file)} must not reach into globalThis`);
  }
});

test('the reducer is deterministic at the source level: no clock, no randomness', () => {
  for (const file of sourceFilesUnder(proposalDir)) {
    const source = strippedSource(file);
    const name = relative(file);
    assert.equal(/\bDate\.now\s*\(/.test(source), false, `${name} must not call Date.now()`);
    assert.equal(/\bnew\s+Date\s*\(/.test(source), false, `${name} must not construct a Date`);
    assert.equal(/\bMath\.random\s*\(/.test(source), false, `${name} must not use Math.random()`);
    assert.equal(/\brandomUUID\b/.test(source), false, `${name} must not mint random ids`);
    assert.equal(/\bperformance\.now\s*\(/.test(source), false, `${name} must not call performance.now()`);
  }
});

test('the proposal module declares types and pure functions, and nothing that writes', () => {
  // What `persistencePort.ts` was for. That file declared the persistence seam
  // and deliberately implemented nothing, so "only a completed confirmation can
  // reach persistence" was structural rather than promised. The seam is now
  // #27's `DecompositionPersistenceAdapter`, which is a sibling track this
  // module may not import — enforced by FORBIDDEN_SIBLING_PATTERNS above — so
  // the same guarantee is restated on what is left: no class, and no `new` of
  // anything, in the whole module.
  //
  // The other half of that file's job, "no proposal type carries an instruction
  // to change the commitment", moved to tests/decomposition/proposalStore.test.ts
  // and is asserted about `ConfirmedDecompositionStep` — the shape that now
  // actually reaches a writer, which is where the claim belongs.
  for (const file of sourceFilesUnder(proposalDir)) {
    const source = strippedSource(file);
    const name = relative(file);
    assert.equal(/\bclass\s+/.test(source), false, `${name} must not declare a class`);
    assert.equal(
      /\bexport\s+(?:async\s+)?function\s+\w*[Pp]ersist/.test(source),
      false,
      `${name} must export nothing that persists`,
    );
  }
});

test('the contract states that the original commitment stays canonical', () => {
  const source = readFileSync(join(repoRoot, 'src', 'contracts', 'v1', 'decompositionContracts.ts'), 'utf8');
  const policy = /DECOMPOSITION_PERSISTENCE_POLICY = Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(source);
  assert.ok(policy, 'expected to find DECOMPOSITION_PERSISTENCE_POLICY');

  assert.match(policy[1], /originalCommitmentRemainsCanonical: true/);
  assert.match(policy[1], /everyStepNeedsExplicitDecision: true/);
  assert.match(policy[1], /proposalCanPersist: false/);
  assert.match(policy[1], /confirmationRequired: true/);
});

/* ── Review regressions: the scanner's own blind spots ────────────── */

test('scanner: the @/ path alias resolves to src/', () => {
  // `resolveLocal` only understood specifiers starting with `.`, while
  // tsconfig maps `@/*` to `./src/*` and 76 imports across lib/ and src/
  // already use it. Anything reached through an `@/` import was invisible to
  // the closure walk — a hole the width of the repo's dominant spelling, in
  // the one test that is the sole evidence for the canonical-commitment
  // criterion.
  const fromFile = join(proposalDir, 'proposalStore.ts');

  assert.equal(
    resolveLocal(fromFile, '@/contracts/v1/decompositionContracts'),
    join(repoRoot, 'src', 'contracts', 'v1', 'decompositionContracts.ts'),
  );
  assert.equal(resolveLocal(fromFile, '@/types'), join(repoRoot, 'src', 'types', 'index.ts'));
});

test('scanner: an unresolvable non-bare specifier fails loudly', () => {
  // Silently returning null is how the alias hole stayed invisible: an
  // un-followed edge and a followed one that found nothing looked the same.
  const fromFile = join(proposalDir, 'proposalStore.ts');

  assert.throws(() => resolveLocal(fromFile, './doesNotExist'), /could not resolve/i);
  assert.throws(() => resolveLocal(fromFile, '@/doesNotExist'), /could not resolve/i);
  // Bare specifiers are not repo files and legitimately resolve to nothing.
  assert.equal(resolveLocal(fromFile, 'node:fs'), null);
  assert.equal(resolveLocal(fromFile, 'react'), null);
});

test('scanner: the closure follows an @/ import into src/', () => {
  // End to end, on a real repo file, so this cannot pass by unit-testing a
  // helper the closure does not actually use.
  const aliasUser = join(repoRoot, 'src', 'utils', 'reminderEngine.ts');
  assert.ok(existsSync(aliasUser), 'expected a repo file that imports through @/');
  assert.match(readFileSync(aliasUser, 'utf8'), /from '@\//, 'expected it to still use the alias');

  const closure = importClosure([aliasUser]);

  assert.ok(
    closure.has(join(repoRoot, 'src', 'types', 'index.ts')),
    'the closure must walk through an @/ specifier, not stop at it',
  );
});

test('scanner: a commented-out import is not read as a real one', () => {
  // The closure read raw source while the content bans read stripped source,
  // so prose in a doc comment naming a writer module reported a violation that
  // no code could cause — and the cheapest way to silence it is to delete the
  // comment explaining the rule.
  const source = [
    '/**',
    " * Historically this imported '../../services/commandService'.",
    ' */',
    "// import { dataStore } from '@/server/dataStore';",
    "import { real } from './real';",
  ].join('\n');

  const found = importSpecifiers(stripComments(source));

  assert.deepEqual(found, ['./real']);
});

test('scanner: an erased type-only import is not a runtime edge', () => {
  // `import type` is removed by the compiler, so it can execute nothing and
  // write nothing. The distinction is load-bearing here: the frozen contract
  // chain reaches src/domain/stateMachine through exactly one such import, and
  // treating that as a runtime dependency would make the guard unsatisfiable
  // without editing a contract this issue may not touch.
  const source = [
    "import type { DomainState } from '../../domain/stateMachine';",
    "export type { Command } from '../../domain/stateMachine';",
    "import { applyCommand } from './realDependency';",
  ].join('\n');

  assert.deepEqual(valueSpecifiers(source), ['./realDependency']);
  assert.deepEqual(typeOnlySpecifiers(source).sort(), [
    '../../domain/stateMachine',
    '../../domain/stateMachine',
  ]);
});

test('scanner: a value import of a banned module is still caught', () => {
  // The other half of the previous test: type-awareness must not become a way
  // to launder a real dependency.
  const source = [
    "import type { DomainState } from '../../domain/stateMachine';",
    "import { applyCommand } from '../../domain/stateMachine';",
  ].join('\n');

  assert.deepEqual(valueSpecifiers(source), ['../../domain/stateMachine']);
  assert.notEqual(forbiddenReason(valueSpecifiers(source)[0]), null);
});

test('the proposal module reaches canonical state through no edge at all', () => {
  // Stated as a property rather than a footnote. This used to read "only
  // through erased type imports", because the deleted store imported the
  // contract for a runtime constant and the contract chain led — through two
  // more hops and one `import type` — to `src/domain/stateMachine`. The reducer
  // names the contract in `import type` only, so the chain is not walked at
  // all; the assertion is correspondingly stronger. If a future edit turns the
  // reducer's contract import into a value import, the closure grows and the
  // leaf test above fails first, which is the earlier and clearer warning.
  const closure = importClosure(sourceFilesUnder(proposalDir));
  const contract = join(repoRoot, 'src', 'contracts', 'v1', 'decompositionContracts.ts');
  const lifeState = join(repoRoot, 'src', 'contracts', 'v1', 'lifeStateContracts.ts');

  assert.equal(closure.has(contract), false, 'the contract is named in `import type` only, so it is not a runtime edge');
  for (const file of sourceFilesUnder(proposalDir)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    if (!source.includes('decompositionContracts')) continue;
    assert.ok(
      typeOnlySpecifiers(source).some((specifier) => specifier.endsWith('decompositionContracts')),
      `${relative(file)} must name the contract as a type, not import it as a value`,
    );
  }

  // And the fact that edge used to be defended: the contract chain's own route
  // to the domain machine is erased, so nothing that imports a contract — here
  // or anywhere — picks up a runtime dependency on canonical state.
  assert.ok(
    typeOnlySpecifiers(stripComments(readFileSync(lifeState, 'utf8'))).some((specifier) =>
      specifier.endsWith('domain/stateMachine'),
    ),
    'the edge to the domain machine must be an erased type import',
  );
  assert.equal(
    closure.has(join(repoRoot, 'src', 'domain', 'stateMachine.ts')),
    false,
    'no runtime path from the proposal module may reach the domain state machine',
  );
});
