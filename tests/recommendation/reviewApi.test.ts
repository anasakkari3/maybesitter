/**
 * The `/api/recommendation/review` boundary (Sprint 08, issue #35).
 *
 * Three claims, and the third is the one that cannot be made any other way:
 *
 *  1. **Nothing persists, and nothing persists before confirmation.** Checked
 *     twice — behaviourally, by asserting no response ever carries a `handoff`
 *     before an explicit confirmation and that every response carries
 *     `persisted: false`; and structurally, by walking the route's import
 *     closure and asserting it reaches no module that writes canonical state.
 *     The behavioural half would keep passing the day someone added a store
 *     write that did not change the response body.
 *
 *  2. **Malformed input is reported, not thrown.** Every hostile body in
 *     `HOSTILE_BODIES` must come back as a 400 carrying a code from the
 *     taxonomy. A route that raises cannot return the list it exists to return,
 *     which is the defect `planningContracts` records three instances of, and a
 *     500 tells a client nothing it can act on.
 *
 *  3. **Redaction holds on the wire.** The blind view is checked after a
 *     round trip through JSON, because that is where a field that only exists
 *     at runtime — a getter, a class field, something spread in by a helper —
 *     would show up. The type-level guarantee is checked in
 *     `reviewContract.test.ts`; this checks the bytes.
 *
 * The route is exercised by calling its exported `POST` with a `Request`, the
 * way `tests/mobile/mobileApiRoutes.test.ts` exercises the mobile routes. No
 * server is started and no DOM is involved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { POST } from '../../src/app/api/recommendation/review/route.ts';
import * as routeModule from '../../src/app/api/recommendation/review/route.ts';
import { blindSlotOrder } from '../../lib/recommendation/review/present.ts';
import { BLIND_REDACTED_FIELDS, REVIEW_FINDING_CODES } from '../../lib/recommendation/review/reviewContract.ts';
import {
  AFTER_EXPIRY,
  FRESH_FINGERPRINTS,
  NOW,
  RECOMMENDATION_ID,
  SECRET_COMMITMENT,
  allKeys,
  offeredChoice,
  pathsContaining,
} from './reviewFixtures.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const routePath = join(repoRoot, 'src', 'app', 'api', 'recommendation', 'review', 'route.ts');

const SALT = 'blind-round-2026-08-19';

function request(body: unknown, raw?: string): Request {
  return new Request('http://127.0.0.1:4321/api/recommendation/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw === undefined ? JSON.stringify(body) : raw,
  });
}

async function post(body: unknown, raw?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await POST(request(body, raw));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function presentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'present',
    recommendation: offeredChoice(),
    locale: 'en',
    mode: 'attributed',
    now: NOW,
    currentFingerprints: FRESH_FINGERPRINTS,
    ...overrides,
  };
}

function decideBody(overrides: Record<string, unknown> = {}, submission: Record<string, unknown> = {}) {
  return {
    kind: 'decide',
    recommendation: offeredChoice(),
    locale: 'en',
    mode: 'attributed',
    now: NOW,
    currentFingerprints: FRESH_FINGERPRINTS,
    submission: {
      recommendationId: RECOMMENDATION_ID,
      target: { mode: 'attributed', optionIndex: 0 },
      verdict: 'accept',
      decidedAt: NOW,
      confirmation: { stage: 'unconfirmed' },
      ...submission,
    },
    ...overrides,
  };
}

function findingCodes(body: Record<string, unknown>): string[] {
  return ((body.findings ?? []) as { code: string }[]).map((entry) => entry.code);
}

/* ── The happy paths ─────────────────────────────────────────────── */

test('review api: presenting an offer returns a view and writes nothing', async () => {
  const { status, body } = await post(presentBody());
  assert.equal(status, 200);
  assert.equal(body.kind, 'presented');
  assert.equal(body.persisted, false);
  const view = body.view as Record<string, unknown>;
  assert.equal(view.mode, 'attributed');
  assert.equal(view.soleness, 'choice');
  assert.ok(Array.isArray(view.alternatives) && (view.alternatives as unknown[]).length === 2);
});

test('review api: a decision without confirmation returns no authority to write', async () => {
  const { status, body } = await post(decideBody());
  assert.equal(status, 200);
  assert.equal(body.kind, 'decided');
  assert.equal(body.persisted, false);
  const outcome = body.outcome as Record<string, unknown>;
  assert.equal(outcome.status, 'confirmation_required');
  assert.equal(outcome.persisted, false);
  // The word does not appear anywhere in the response, at any depth.
  assert.ok(!allKeys(body).has('handoff'));
});

test('review api: an explicit confirmation returns a handoff and still reports no write', async () => {
  const { status, body } = await post(
    decideBody({}, {
      confirmation: { stage: 'confirmed', acknowledgedVerdict: 'accept', acknowledgedIndex: 0, confirmedAt: NOW },
    }),
  );
  assert.equal(status, 200);
  assert.equal(body.persisted, false);
  const outcome = body.outcome as Record<string, unknown>;
  assert.equal(outcome.status, 'confirmed');
  assert.equal(outcome.persisted, false);
  const handoff = outcome.handoff as Record<string, unknown>;
  assert.equal(handoff.optionIndex, 0);
  assert.equal(handoff.verdict, 'accept');
  assert.equal(handoff.recommendationId, RECOMMENDATION_ID);
});

test('review api: declining costs nothing and produces no handoff even when confirmed', async () => {
  for (const verdict of ['defer', 'dismiss'] as const) {
    const { status, body } = await post(
      decideBody({}, {
        verdict,
        confirmation: { stage: 'confirmed', acknowledgedVerdict: verdict, acknowledgedIndex: 0, confirmedAt: NOW },
      }),
    );
    assert.equal(status, 200, verdict);
    assert.equal((body.outcome as Record<string, unknown>).status, 'recorded_without_penalty');
    assert.ok(!allKeys(body).has('handoff'));
  }
});

/* ── Redaction, on the wire ──────────────────────────────────────── */

test('review api: a blind presentation carries no first-pass judgement after serialisation', async () => {
  const { status, body } = await post(presentBody({ mode: 'blind', blindingSalt: SALT }));
  assert.equal(status, 200);
  const view = body.view as Record<string, unknown>;
  assert.equal(view.mode, 'blind');
  const keys = allKeys(view);
  for (const redacted of BLIND_REDACTED_FIELDS) {
    assert.ok(!keys.has(redacted), `the wire format carries the redacted field ${redacted}`);
  }
  // The slots are still there and still reviewable, or the redaction would be
  // trivially satisfied by sending nothing.
  assert.equal((view.slots as unknown[]).length, 3);
});

test('review api: a blind reviewer cannot recover the offer order from the response', async () => {
  const { body } = await post(presentBody({ mode: 'blind', blindingSalt: SALT }));
  const serialised = JSON.stringify(body);
  // The offer order is the one thing the response must not let a rater
  // reconstruct. `optionIndex` is the direct form of it; `confidence` is the
  // number it was ranked on.
  assert.ok(!serialised.includes('optionIndex'));
  assert.ok(!serialised.includes('confidence'));
  // And the mapping really is recoverable server side, so nothing was lost —
  // it just was not sent.
  assert.equal(blindSlotOrder(offeredChoice(), SALT).length, 3);
});

test('review api: a caller-chosen id reaches the wire only in its own typed field', async () => {
  const { body } = await post(presentBody());
  const allowed = new Set(['commitmentId', 'proposalId', 'recommendationId', 'itemId']);
  for (const path of pathsContaining(body, SECRET_COMMITMENT)) {
    const leaf = path.slice(path.lastIndexOf('.') + 1);
    assert.ok(allowed.has(leaf), `${SECRET_COMMITMENT} reached ${path}`);
  }
});

/* ── Refusals ────────────────────────────────────────────────────── */

test('review api: a stale recommendation is shown as nothing to review, not as an offer', async () => {
  const { status, body } = await post(presentBody({ now: AFTER_EXPIRY }));
  assert.equal(status, 200);
  const view = body.view as Record<string, unknown>;
  assert.equal(view.mode, 'none');
  assert.equal(view.cause, 'stale');
  assert.deepEqual(view.stalenessCodes, ['EXPIRED']);
});

test('review api: a decision against a stale recommendation is refused', async () => {
  const { status, body } = await post(decideBody({ now: AFTER_EXPIRY }));
  assert.equal(status, 400);
  assert.deepEqual(findingCodes(body), ['NOTHING_OFFERED']);
});

/**
 * Bodies a client should never send, and what each must be told.
 *
 * Table-driven rather than one test per case, because the property being
 * asserted is uniform — every one of these is a 400 carrying a code from the
 * taxonomy, and none of them throws — and a table makes adding the next hostile
 * shape a one-line change rather than a new test somebody forgets to write.
 */
const HOSTILE_BODIES: readonly { readonly name: string; readonly body: unknown; readonly expect: string }[] = [
  { name: 'a bare string', body: 'not an object', expect: 'MALFORMED_REQUEST_BODY' },
  { name: 'an array', body: [], expect: 'MALFORMED_REQUEST_BODY' },
  { name: 'null', body: null, expect: 'MALFORMED_REQUEST_BODY' },
  { name: 'a number', body: 42, expect: 'MALFORMED_REQUEST_BODY' },
  { name: 'an unknown kind', body: { kind: 'delete_everything' }, expect: 'UNSUPPORTED_REQUEST_KIND' },
  { name: 'no kind at all', body: {}, expect: 'UNSUPPORTED_REQUEST_KIND' },
];

test('review api: every malformed envelope is reported rather than thrown', async () => {
  for (const hostile of HOSTILE_BODIES) {
    const { status, body } = await post(hostile.body);
    assert.equal(status, 400, hostile.name);
    assert.equal(body.kind, 'rejected', hostile.name);
    assert.equal(body.persisted, false, hostile.name);
    assert.deepEqual(findingCodes(body), [hostile.expect], hostile.name);
  }
});

test('review api: a body that is not JSON at all is reported rather than thrown', async () => {
  // The one malformed input the pure handler cannot see, because it fails in the
  // parser before there is a value to inspect.
  const { status, body } = await post(undefined, '{ this is not json');
  assert.equal(status, 400);
  assert.deepEqual(findingCodes(body), ['MALFORMED_REQUEST_BODY']);
});

test('review api: every missing or malformed field earns its own code', async () => {
  const cases: readonly { readonly name: string; readonly body: unknown; readonly expect: string }[] = [
    { name: 'no evaluation instant', body: presentBody({ now: undefined }), expect: 'MISSING_EVALUATION_INSTANT' },
    { name: 'an unparseable instant', body: presentBody({ now: 'the day after tomorrow' }), expect: 'INVALID_INSTANT' },
    { name: 'an unsupported locale', body: presentBody({ locale: 'fr' }), expect: 'UNSUPPORTED_LOCALE' },
    { name: 'no recommendation', body: presentBody({ recommendation: undefined }), expect: 'MALFORMED_RECOMMENDATION' },
    { name: 'a recommendation with no outcome', body: presentBody({ recommendation: { recommendationId: 'x' } }), expect: 'MALFORMED_RECOMMENDATION' },
    { name: 'an unsupported mode', body: presentBody({ mode: 'peek' }), expect: 'UNSUPPORTED_REQUEST_KIND' },
    { name: 'a blind view with no salt', body: presentBody({ mode: 'blind' }), expect: 'BLINDING_SALT_REQUIRED' },
    { name: 'a blind view with a blank salt', body: presentBody({ mode: 'blind', blindingSalt: '  ' }), expect: 'BLINDING_SALT_REQUIRED' },
    { name: 'a fingerprint map of objects', body: presentBody({ currentFingerprints: { 'obs-due': { was: 1 } } }), expect: 'MALFORMED_FINGERPRINT_MAP' },
    { name: 'no submission', body: decideBody({ submission: undefined }), expect: 'MALFORMED_SUBMISSION' },
    { name: 'a submission with no target', body: decideBody({}, { target: undefined }), expect: 'MALFORMED_SUBMISSION' },
    { name: 'a submission with an unknown verdict', body: decideBody({}, { verdict: 'obliterate' }), expect: 'MALFORMED_SUBMISSION' },
    { name: 'a submission with no confirmation field', body: decideBody({}, { confirmation: undefined }), expect: 'MALFORMED_SUBMISSION' },
    { name: 'a confirmation of an unknown stage', body: decideBody({}, { confirmation: { stage: 'maybe' } }), expect: 'MALFORMED_SUBMISSION' },
    { name: 'a decision naming another recommendation', body: decideBody({}, { recommendationId: 'rec-elsewhere' }), expect: 'RECOMMENDATION_ID_MISMATCH' },
    { name: 'a position past the offer', body: decideBody({}, { target: { mode: 'attributed', optionIndex: 9 } }), expect: 'TARGET_OUT_OF_RANGE' },
    { name: 'an accept with no position', body: decideBody({}, { target: { mode: 'attributed', optionIndex: null } }), expect: 'TARGET_REQUIRED' },
    { name: 'an edit with no replacement', body: decideBody({}, { verdict: 'edit' }), expect: 'EDIT_TITLE_REQUIRED' },
    { name: 'a stray replacement title', body: decideBody({}, { editedTitle: 'something else' }), expect: 'EDIT_TITLE_NOT_APPLICABLE' },
    {
      name: 'an attributed target on a blind review',
      body: decideBody({ mode: 'blind' }, {}),
      expect: 'TARGET_MODE_MISMATCH',
    },
    {
      name: 'a drifted confirmation',
      body: decideBody({}, {
        confirmation: { stage: 'confirmed', acknowledgedVerdict: 'accept', acknowledgedIndex: 2, confirmedAt: NOW },
      }),
      expect: 'CONFIRMATION_TARGET_MISMATCH',
    },
    {
      name: 'a confirmation timed in nonsense',
      body: decideBody({}, {
        confirmation: { stage: 'confirmed', acknowledgedVerdict: 'accept', acknowledgedIndex: 0, confirmedAt: 'soon' },
      }),
      expect: 'INVALID_INSTANT',
    },
  ];

  for (const scenario of cases) {
    const { status, body } = await post(scenario.body);
    assert.equal(status, 400, scenario.name);
    assert.equal(body.persisted, false, scenario.name);
    const codes = findingCodes(body);
    assert.ok(codes.includes(scenario.expect), `${scenario.name}: expected ${scenario.expect}, got ${codes.join(', ')}`);
    for (const code of codes) {
      assert.ok((REVIEW_FINDING_CODES as readonly string[]).includes(code), `${scenario.name}: ${code} is not in the taxonomy`);
    }
  }
});

test('review api: no refusal ever produces a handoff or claims a write', async () => {
  for (const scenario of [...HOSTILE_BODIES.map((entry) => entry.body), decideBody({ now: AFTER_EXPIRY })]) {
    const { body } = await post(scenario);
    assert.ok(!allKeys(body).has('handoff'));
    assert.equal(body.persisted, false);
  }
});

/* ── Structural: the route cannot write ──────────────────────────── */

/** Modules that write canonical user state or reach persistence directly. */
const FORBIDDEN_MODULE_BASENAMES = [
  'commandService',
  'deterministicStateGateway',
  'dataStore',
  'behaviorFeedbackService',
  'stateMachine',
  'captureBoundaryService',
  'eventStore',
  'pilotTrustStore',
] as const;

function importSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match !== null) {
      specifiers.push(match[1]);
      match = pattern.exec(text);
    }
  }
  return specifiers;
}

function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier.replace(/\.tsx?$/, ''));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) || null;
}

/**
 * Every repo file reachable from `roots`.
 *
 * A *closure* walk rather than a direct-import check, following
 * `tests/decomposition/boundaryImportClosure.test.ts`, whose header records why:
 * a direct-import check happily missed a writer reached through a single
 * intermediate module.
 */
function importClosure(roots: readonly string[]): Map<string, string[]> {
  const closure = new Map<string, string[]>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (closure.has(file)) continue;
    const specifiers = importSpecifiers(readFileSync(file, 'utf8'));
    closure.set(file, specifiers);
    for (const specifier of specifiers) {
      const resolved = resolveLocal(file, specifier);
      if (resolved !== null && !closure.has(resolved)) queue.push(resolved);
    }
  }
  return closure;
}

test('review api: nothing the route can reach is able to write canonical state', () => {
  const closure = importClosure([routePath]);
  assert.ok(closure.size >= 4, 'the closure walk found suspiciously little');
  for (const [file, specifiers] of Array.from(closure.entries())) {
    for (const specifier of specifiers) {
      const resolved = resolveLocal(file, specifier);
      const target = resolved ?? specifier;
      for (const forbidden of FORBIDDEN_MODULE_BASENAMES) {
        assert.ok(
          !target.includes(`/${forbidden}`) && !target.endsWith(forbidden),
          `${file} reaches ${forbidden} through ${specifier}`,
        );
      }
    }
  }
});

test('review api: the route reads no clock and the module reaches none either', () => {
  // `now` is a required field of the request body. The shipped pilot route does
  // read the clock; that is a property of a surface that recomputes on every
  // request and never holds a proposal. This module's output is meant to be
  // held, which is why it has an expiry, and an expiry check that reads the
  // clock is unreplayable in an audit.
  const closure = importClosure([routePath]);
  for (const file of Array.from(closure.keys())) {
    if (!file.includes('/lib/recommendation/') && file !== routePath) continue;
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const pattern of [/\bDate\.now\s*\(/, /\bnew\s+Date\s*\(\s*\)/, /\bMath\.random\s*\(/, /randomUUID/]) {
      assert.ok(!pattern.test(text), `${file} matches ${pattern}`);
    }
  }
});

test('review api: the route exposes one verb and no read that could be cached', () => {
  const exported = Object.keys(routeModule).sort();
  assert.deepEqual(exported, ['POST', 'dynamic']);
  assert.equal(routeModule.dynamic, 'force-dynamic');
});
