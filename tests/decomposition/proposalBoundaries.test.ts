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
 * Source with its comments removed.
 *
 * The content bans below are about what the code *does*, and these modules
 * explain in prose why they read no clock. Scanning raw text would flag those
 * explanations, and the cheapest way to make such a scanner green is to delete
 * the comment that states the rule — so the scanner would be pushing the code
 * in the wrong direction. The line-comment pattern keeps the character before
 * `//`, so a `https://` inside a string literal is not read as a comment.
 */
function strippedSource(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier.replace(/\.tsx?$/, ''));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) || null;
}

/** Every repo file reachable from `roots`, mapped to its own import specifiers. */
function importClosure(roots: readonly string[]): Map<string, string[]> {
  const closure = new Map<string, string[]>();
  const queue = roots.slice();

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (closure.has(file)) continue;

    const specifiers = importSpecifiers(readFileSync(file, 'utf8'));
    closure.set(file, specifiers);

    for (const specifier of specifiers) {
      const resolved = resolveLocal(file, specifier);
      if (resolved && !closure.has(resolved)) queue.push(resolved);
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
  for (const expected of ['proposalStateMachine.ts', 'proposalStore.ts', 'persistencePort.ts']) {
    assert.ok(
      files.some((file) => file.endsWith(expected)),
      `expected ${expected} to be part of the scanned surface`,
    );
  }
});

test('scanner: the closure walks past the first hop', () => {
  // Without this, the whole file would silently degrade into a direct-import
  // check — which is exactly what a writer reached through one intermediate
  // module slips past.
  const roots = sourceFilesUnder(proposalDir);
  const closure = importClosure(roots);
  const directlyImported = new Set(
    roots.flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8'))
        .map((specifier) => resolveLocal(file, specifier))
        .filter((resolved): resolved is string => resolved !== null),
    ),
  );

  assert.ok(
    Array.from(closure.keys()).some((file) => !roots.includes(file) && !directlyImported.has(file)),
    'expected the closure to reach at least one module more than one hop away',
  );
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

test('the persistence port is a declaration and nothing else', () => {
  // The structural half of "only a completed confirmation can reach
  // persistence". An implementation living here would give the reducer's own
  // module a code path to canonical state, and the guarantee would rest on
  // nobody calling it.
  const source = strippedSource(portFile);

  assert.match(source, /export interface DecompositionPersistencePort/, 'the port must be declared here');
  assert.equal(/\bclass\s+/.test(source), false, 'persistencePort.ts must not implement the port');
  assert.equal(
    /export\s+(?:async\s+)?function\s/.test(source),
    false,
    'persistencePort.ts must export no runtime function; it is types only',
  );
  assert.equal(/\bexport const\b/.test(source), false, 'persistencePort.ts must export no runtime value');
});

test('no proposal type carries an instruction to change the commitment', () => {
  // The other half: a batch that could express "and rename the commitment"
  // would let a malformed proposal talk an adapter into a canonical edit. The
  // shape carries no such field, so there is nothing for an adapter to obey.
  const source = strippedSource(portFile);
  const batch = /export interface ConfirmedStepBatch \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(batch, 'expected to find the ConfirmedStepBatch declaration');

  assert.match(batch[1], /readonly commitmentId: string;/, 'the batch says what the steps belong to');
  for (const forbidden of ['commitmentTitle', 'commitmentUpdate', 'commitmentPatch', 'replaceCommitment']) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\b`).test(batch[1]),
      false,
      `ConfirmedStepBatch must not carry ${forbidden}; decomposition adds steps beside a commitment, never rewrites it`,
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
