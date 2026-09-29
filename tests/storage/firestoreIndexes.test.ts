/**
 * The index configuration matches the queries the code makes (UC-1.0c #142).
 *
 * The first real deploy failed with:
 *
 *   HTTP Error: 400, this index is not necessary,
 *   configure using single field index controls
 *
 * on `jobs/dedupeKey`. A single field inside one collection is indexed
 * automatically, so declaring it as a composite index is an error — while a
 * single field queried across a *collection group* is not automatic at all and
 * has to be a field override. The file had both kinds in the wrong place, and
 * nothing checked it against the queries, which is what this does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFilesUnder } from './importClosure.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(repoRoot, 'firestore.indexes.json'), 'utf8')) as {
  indexes: Array<{ collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string }> }>;
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; indexes: Array<{ queryScope: string }> }>;
};

/** `listGroup(COLLECTION, { where: [['field', ...]] })` — the group queries that need an override. */
function groupQueriesInSource(): Array<{ collection: string; field: string; where: string }> {
  const found: Array<{ collection: string; field: string; where: string }> = [];
  const call = /listGroup<[^>]*>\(\s*([A-Z_]+)\s*,\s*\{[^}]*?where:\s*\[\[\s*'([^']+)'/g;
  for (const file of [...sourceFilesUnder(join(repoRoot, 'lib')), ...sourceFilesUnder(join(repoRoot, 'src'))]) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('storageAdapter.ts') || file.endsWith('memoryAdapter.ts') || file.endsWith('firestoreAdapter.ts')) continue;
    for (const match of Array.from(text.matchAll(call))) {
      found.push({ collection: match[1]!, field: match[2]!, where: `${file.slice(repoRoot.length + 1)}` });
    }
  }
  return found;
}

/** `MEMORY` -> `memory`: the constants in lib/storage/paths.ts. */
function collectionNames(): Record<string, string> {
  const paths = readFileSync(join(repoRoot, 'lib/storage/paths.ts'), 'utf8');
  return Object.fromEntries(Array.from(paths.matchAll(/^export const ([A-Z_]+) = '([A-Za-z]+)';$/gm), (m) => [m[1]!, m[2]!]));
}

test('no composite index declares a single field in one collection, which Firestore rejects', () => {
  const offenders = config.indexes
    .filter((index) => index.queryScope === 'COLLECTION' && index.fields.length < 2)
    .map((index) => `${index.collectionGroup}.${index.fields.map((f) => f.fieldPath).join(',')}`);
  assert.deepEqual(offenders, [], 'Firestore answers 400 "this index is not necessary" for these');
});

test('every filtered collection-group query has a COLLECTION_GROUP field override', () => {
  const names = collectionNames();
  const queries = groupQueriesInSource();
  assert.ok(queries.length >= 4, `expected to find the known group queries, found ${queries.length}`);

  for (const query of queries) {
    const collection = names[query.collection];
    assert.ok(collection, `unknown collection constant ${query.collection} in ${query.where}`);
    const override = config.fieldOverrides.find(
      (entry) => entry.collectionGroup === collection && entry.fieldPath === query.field,
    );
    assert.ok(override, `${query.where}: listGroup('${collection}') filters on '${query.field}' with no field override`);
    assert.ok(
      override.indexes.some((index) => index.queryScope === 'COLLECTION_GROUP'),
      `${collection}.${query.field} has an override but no COLLECTION_GROUP scope, so the query fails`,
    );
  }
});

test('the scheduler composite indexes match what claimDueJobs and recoverClaimedJobs query', () => {
  const store = readFileSync(join(repoRoot, 'lib/scheduler/storageSchedulerStore.ts'), 'utf8');
  const pairs = [
    ['status', 'runAt'],
    ['status', 'claimedAt'],
  ] as const;
  for (const [first, second] of pairs) {
    assert.match(store, new RegExp(`where: \\[\\['${first}', '==', [^\\]]+\\], \\['${second}', '<=',`), `no query uses ${first}+${second}`);
    assert.ok(
      config.indexes.some((index) =>
        index.collectionGroup === 'jobs' && index.fields.map((f) => f.fieldPath).join(',') === `${first},${second}`),
      `jobs is missing the ${first}+${second} composite index`,
    );
  }
});

test('the event-log composite index matches what listEventsOfTypeInRange queries (#443)', () => {
  // The memory suggestions read only the event types their rules count: an
  // equality on `type` plus a range and an order on `at`. Firestore answers
  // that shape with 400 FAILED_PRECONDITION unless `events (type, at)` is
  // declared, and neither the memory adapter nor the emulator enforces it, so
  // the query is read out of the source rather than retyped here.
  const source = readFileSync(join(repoRoot, 'lib/services/mobile/eventLog.ts'), 'utf8');
  const start = source.indexOf('export async function listEventsOfTypeInRange');
  assert.ok(start >= 0, 'listEventsOfTypeInRange is gone; this test no longer checks the query it names');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(body, /userCol\(uid, EVENTS\)/, 'the typed range read no longer reads the events collection');
  const filters = Array.from(body.matchAll(/\['([A-Za-z]+)', '(==|<|<=|>|>=)'/g), (m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(filters, ['type ==', 'at >=', 'at <'], 'the typed range read no longer asks what this test thinks it asks');
  assert.match(body, /orderBy: \{ field: 'at', direction: 'asc' \}/);

  assert.equal(collectionNames().EVENTS, 'events');
  const declared = config.indexes
    .filter((index) => index.collectionGroup === 'events' && index.queryScope === 'COLLECTION')
    .map((index) => index.fields.map((field) => `${field.fieldPath} ${(field as { order?: string }).order}`).join(','));
  assert.ok(
    declared.includes('type ASCENDING,at ASCENDING'),
    `events is missing the type+at composite index. Declared: ${JSON.stringify(declared)}`,
  );
});

/* ------------------------------------------------------------------------ *
 * The query census (live P1, 2026-09-29).
 *
 * Following a football club on production answered 500: `listFixturesForTeam`
 * asks `fixtures` for `homeTeamId ==` plus a range on `kickoffUtc`, Firestore
 * refuses that with 9 FAILED_PRECONDITION unless the composite index exists,
 * and neither the memory adapter nor the emulator enforces indexes — so every
 * test was green while the route could not work anywhere real. The per-query
 * tests above only guard the queries someone remembered to write a test for.
 *
 * This walks every `list`/`listGroup` call in lib/ and src/ with the
 * TypeScript parser, works out the index each one needs from its `where` and
 * `orderBy`, and asserts `firestore.indexes.json` declares it. A new query
 * that needs an index fails here instead of in production.
 * ------------------------------------------------------------------------ */

import ts from 'typescript';

type Op = '==' | '<' | '<=' | '>' | '>=';
interface QueryShape {
  readonly site: string;
  readonly method: 'list' | 'listGroup';
  readonly collection: string | null;
  readonly where: ReadonlyArray<{ field: string; op: Op }>;
  readonly orderBy: ReadonlyArray<{ field: string; direction: 'ASCENDING' | 'DESCENDING' }>;
}

/**
 * Call sites whose collection is not a `paths.ts` constant in the call itself.
 * Only consulted when the query needs an index; a site that needs one and is
 * not here fails with its location so it can be added.
 */
const COLLECTION_OF_SITE: Record<string, string> = {
  'lib/scheduler/storageSchedulerStore.ts': 'jobs',
};

const DYNAMIC = '<dynamic>';
const STORAGE_RECEIVER = /(^|\.)(storage|reader|tx)$|getStorage\(\)$|storageOf\([^)]*\)$/;

function stringOf(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return stringOf(node.expression);
  return null;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** The array a local helper like `windowWhere(window)` returns. */
function localReturnedArray(source: ts.SourceFile, name: string): ts.ArrayLiteralExpression | null {
  let found: ts.ArrayLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) {
      for (const statement of node.body.statements) {
        if (ts.isReturnStatement(statement) && statement.expression) {
          const value = unwrap(statement.expression);
          if (ts.isArrayLiteralExpression(value)) found = value;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function whereEntries(source: ts.SourceFile, array: ts.ArrayLiteralExpression, site: string): QueryShape['where'] {
  const entries: Array<{ field: string; op: Op }> = [];
  for (const element of array.elements) {
    if (ts.isSpreadElement(element)) {
      const inner = unwrap(element.expression);
      if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
        const returned = localReturnedArray(source, inner.expression.text);
        assert.ok(returned, `${site}: cannot read the filters \`${inner.expression.text}()\` returns`);
        entries.push(...whereEntries(source, returned, site));
        continue;
      }
      assert.fail(`${site}: a spread in \`where\` the census cannot read`);
    }
    const tuple = unwrap(element);
    assert.ok(ts.isArrayLiteralExpression(tuple), `${site}: a \`where\` entry that is not a [field, op, value] tuple`);
    const op = stringOf(tuple.elements[1] as ts.Expression);
    assert.ok(op && ['==', '<', '<=', '>', '>='].includes(op), `${site}: a \`where\` operator the census cannot read`);
    entries.push({ field: stringOf(tuple.elements[0] as ts.Expression) ?? DYNAMIC, op: op as Op });
  }
  return entries;
}

/** Collects `where`/`orderBy` from an options literal, including `...(c ? { where } : {})`. */
function readOptions(
  source: ts.SourceFile,
  literal: ts.ObjectLiteralExpression,
  site: string,
  into: { where: Array<{ field: string; op: Op }>; orderBy: Array<{ field: string; direction: 'ASCENDING' | 'DESCENDING' }> },
): void {
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = unwrap(property.expression);
      const branches = ts.isConditionalExpression(spread) ? [spread.whenTrue, spread.whenFalse] : [spread];
      for (const branch of branches) {
        const value = unwrap(branch);
        assert.ok(ts.isObjectLiteralExpression(value), `${site}: an options spread the census cannot read`);
        readOptions(source, value, site, into);
      }
      continue;
    }
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
    const value = unwrap(property.initializer);
    if (property.name.text === 'where') {
      assert.ok(ts.isArrayLiteralExpression(value), `${site}: \`where\` is not an array literal`);
      into.where.push(...whereEntries(source, value, site));
    }
    if (property.name.text === 'orderBy') {
      assert.ok(ts.isObjectLiteralExpression(value), `${site}: \`orderBy\` is not an object literal`);
      let field: string | null = null;
      let direction: 'ASCENDING' | 'DESCENDING' = 'ASCENDING';
      for (const part of value.properties) {
        if (!ts.isPropertyAssignment(part) || !ts.isIdentifier(part.name)) continue;
        if (part.name.text === 'field') field = stringOf(part.initializer);
        if (part.name.text === 'direction' && stringOf(part.initializer) === 'desc') direction = 'DESCENDING';
      }
      into.orderBy.push({ field: field ?? DYNAMIC, direction });
    }
  }
}

/**
 * The text naming the collection: the first argument itself, or — when that is
 * a local like `const collection = requireCollectionPath(FIXTURES)` — the
 * local's initializer in the enclosing function.
 */
function collectionText(call: ts.CallExpression, source: ts.SourceFile): string {
  const first = unwrap(call.arguments[0]!);
  if (!ts.isIdentifier(first)) return first.getText(source);
  let scope: ts.Node | undefined = call.parent;
  while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
  let initializer: string | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === first.text && node.initializer) {
      initializer = node.initializer.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  if (scope) visit(scope);
  return initializer ?? first.getText(source);
}

function queryShapesInSource(): QueryShape[] {
  const names = collectionNames();
  const shapes: QueryShape[] = [];
  const files = [...sourceFilesUnder(join(repoRoot, 'lib')), ...sourceFilesUnder(join(repoRoot, 'src'))]
    .filter((file) => !file.includes(`${join('lib', 'storage')}/`));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!/\.list(Group)?\b/.test(text)) continue;
    const relative = file.slice(repoRoot.length + 1);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'list' || node.expression.name.text === 'listGroup') &&
        node.arguments.length >= 2
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const site = `${relative}:${line}`;
        const options = unwrap(node.arguments[1]!);
        // `links.list(scopeId, goalId)` and friends are domain stores, not the
        // storage adapter; the adapter is always reached through one of these.
        const receiver = node.expression.expression.getText(source);
        if (!STORAGE_RECEIVER.test(receiver) && !ts.isObjectLiteralExpression(options)) {
          ts.forEachChild(node, visit);
          return;
        }
        assert.ok(ts.isObjectLiteralExpression(options), `${site}: query options are not a literal the census can read`);
        const into = { where: [] as Array<{ field: string; op: Op }>, orderBy: [] as Array<{ field: string; direction: 'ASCENDING' | 'DESCENDING' }> };
        readOptions(source, options, site, into);
        const constants = collectionText(node, source).match(/\b[A-Z][A-Z0-9_]*\b/g) ?? [];
        const known = constants.filter((constant) => names[constant]);
        shapes.push({
          site,
          method: node.expression.name.text,
          collection: known.length > 0 ? names[known[known.length - 1]!]! : COLLECTION_OF_SITE[relative] ?? null,
          where: into.where,
          orderBy: into.orderBy,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return shapes;
}

interface RequiredIndex {
  readonly kind: 'composite' | 'override';
  readonly scope: 'COLLECTION' | 'COLLECTION_GROUP';
  readonly equality: readonly string[];
  readonly ordered: ReadonlyArray<{ field: string; direction: 'ASCENDING' | 'DESCENDING' }>;
}

/**
 * The index Firestore needs for one query, or null when the automatic
 * single-field indexes serve it: one field only, or equalities alone (which
 * Firestore answers by merging single-field indexes).
 */
function requiredIndex(shape: QueryShape): RequiredIndex | null {
  const equality = Array.from(new Set(shape.where.filter((w) => w.op === '==').map((w) => w.field)));
  const ordered: Array<{ field: string; direction: 'ASCENDING' | 'DESCENDING' }> = [];
  for (const range of shape.where.filter((w) => w.op !== '==')) {
    if (ordered.some((o) => o.field === range.field)) continue;
    const explicit = shape.orderBy.find((o) => o.field === range.field);
    ordered.push({ field: range.field, direction: explicit?.direction ?? 'ASCENDING' });
  }
  for (const order of shape.orderBy) {
    if (!ordered.some((o) => o.field === order.field) && !equality.includes(order.field)) ordered.push(order);
  }
  const distinct = new Set([...equality, ...ordered.map((o) => o.field)]);
  const scope = shape.method === 'listGroup' ? 'COLLECTION_GROUP' : 'COLLECTION';
  if (distinct.size === 0) return null;
  if (distinct.size === 1) {
    return scope === 'COLLECTION_GROUP'
      ? { kind: 'override', scope, equality, ordered }
      : null;
  }
  if (ordered.length === 0 && scope === 'COLLECTION') return null;
  return { kind: 'composite', scope, equality, ordered };
}

function declares(index: RequiredIndex, collection: string): boolean {
  if (index.kind === 'override') {
    const field = index.equality[0] ?? index.ordered[0]!.field;
    const direction = index.ordered[0]?.direction ?? 'ASCENDING';
    return config.fieldOverrides.some((entry) =>
      entry.collectionGroup === collection &&
      entry.fieldPath === field &&
      entry.indexes.some((i) => i.queryScope === 'COLLECTION_GROUP' && ((i as { order?: string }).order ?? 'ASCENDING') === direction));
  }
  return config.indexes.some((declared) => {
    if (declared.collectionGroup !== collection || declared.queryScope !== index.scope) return false;
    const fields = declared.fields as Array<{ fieldPath: string; order?: string }>;
    if (fields.length !== index.equality.length + index.ordered.length) return false;
    const prefix = fields.slice(0, index.equality.length).map((f) => f.fieldPath).sort();
    if (prefix.join(',') !== [...index.equality].sort().join(',')) return false;
    return index.ordered.every((o, i) => {
      const f = fields[index.equality.length + i]!;
      return f.fieldPath === o.field && (f.order ?? 'ASCENDING') === o.direction;
    });
  });
}

function describe(index: RequiredIndex, collection: string | null): string {
  const fields = [...index.equality.map((f) => `${f} ASC`), ...index.ordered.map((o) => `${o.field} ${o.direction === 'ASCENDING' ? 'ASC' : 'DESC'}`)];
  return `${collection ?? '?'} ${index.scope} ${index.kind} (${fields.join(', ')})`;
}

test('the census reads the queries it claims to, including the football fixtures pair', () => {
  const shapes = queryShapesInSource();
  // A regex or parser change that finds nothing would pass every check below.
  assert.ok(shapes.length >= 25, `expected the known filtered/ordered queries, found ${shapes.length}`);
  const fixtures = shapes.filter((shape) => shape.collection === 'fixtures');
  assert.deepEqual(
    fixtures.map((shape) => shape.where.map((w) => `${w.field} ${w.op}`).join(', ')).sort(),
    ['awayTeamId ==, kickoffUtc >=, kickoffUtc <', 'homeTeamId ==, kickoffUtc >=, kickoffUtc <'],
    'the fixtures-by-team queries are no longer what the census reads',
  );
  const scheduler = shapes.filter((shape) => shape.site.startsWith('lib/scheduler/storageSchedulerStore.ts'));
  assert.ok(scheduler.some((shape) => shape.collection === 'jobs' && shape.orderBy.some((o) => o.field === 'runAt')));
});

test('every query that needs a composite index or group override has one in firestore.indexes.json', () => {
  const missing: string[] = [];
  for (const shape of queryShapesInSource()) {
    const index = requiredIndex(shape);
    if (!index) continue;
    const fields = [...index.equality, ...index.ordered.map((o) => o.field)];
    if (fields.includes(DYNAMIC)) {
      missing.push(`${shape.site}: needs an index on a field named at runtime — the census cannot check it`);
      continue;
    }
    if (!shape.collection) {
      missing.push(`${shape.site}: needs ${describe(index, null)} but its collection is unknown; add it to COLLECTION_OF_SITE`);
      continue;
    }
    if (!declares(index, shape.collection)) missing.push(`${shape.site}: needs ${describe(index, shape.collection)}`);
  }
  assert.deepEqual(missing, [], 'Firestore answers these with 9 FAILED_PRECONDITION until the index exists');
});

test('the census knows which shapes Firestore serves without a declared index', () => {
  const base = { site: 't', collection: 'c', method: 'list' as const };
  assert.equal(requiredIndex({ ...base, where: [{ field: 'a', op: '==' }], orderBy: [] }), null);
  assert.equal(requiredIndex({ ...base, where: [{ field: 'a', op: '==' }, { field: 'b', op: '==' }], orderBy: [] }), null);
  assert.equal(requiredIndex({ ...base, where: [{ field: 'a', op: '<=' }], orderBy: [{ field: 'a', direction: 'DESCENDING' }] }), null);
  assert.deepEqual(
    requiredIndex({ ...base, where: [{ field: 'a', op: '==' }, { field: 'b', op: '>=' }, { field: 'b', op: '<' }], orderBy: [] }),
    { kind: 'composite', scope: 'COLLECTION', equality: ['a'], ordered: [{ field: 'b', direction: 'ASCENDING' }] },
  );
  assert.deepEqual(
    requiredIndex({ ...base, where: [{ field: 'a', op: '==' }], orderBy: [{ field: 'b', direction: 'DESCENDING' }] }),
    { kind: 'composite', scope: 'COLLECTION', equality: ['a'], ordered: [{ field: 'b', direction: 'DESCENDING' }] },
  );
  assert.equal(requiredIndex({ ...base, method: 'listGroup', where: [{ field: 'a', op: '==' }], orderBy: [] })?.kind, 'override');
});
