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
import { blindSlotOrder, evaluateReviewSubmission, handleReviewRequest } from '../../lib/recommendation/review/present.ts';
import {
  BLIND_VIEW_ALLOWED_FIELDS,
  BLIND_REDACTED_FIELDS,
  RECOMMENDATION_REVIEW_LIMITS,
  REVIEW_FINDING_CODES,
} from '../../lib/recommendation/review/reviewContract.ts';
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

test('review api: a confirmation is acknowledged without write authority crossing the wire', async () => {
  // The earlier revision asserted the opposite — that the response *carried* the
  // handoff — and that assertion was the leak: `handoff.optionIndex` is the
  // offer position, so a blind reviewer's confirmation came back naming the
  // thing a blind exchange exists to withhold. Write authority is now a sibling
  // of the outcome inside the module and is not part of the response type.
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
  assert.ok(!allKeys(body).has('handoff'), 'write authority crossed the wire');
  assert.ok(!allKeys(body).has('optionIndex'), 'an offer position crossed the wire');

  // The module still produces the authority internally, for an adapter.
  const internal = evaluateReviewSubmission({
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
      confirmation: { stage: 'confirmed', acknowledgedVerdict: 'accept', acknowledgedIndex: 0, confirmedAt: NOW },
    },
  });
  assert.equal(internal.ok, true);
  if (!internal.ok) return;
  assert.ok(internal.handoff !== null);
  assert.equal(internal.handoff.optionIndex, 0);
  assert.equal(internal.handoff.recommendationId, RECOMMENDATION_ID);
});

test('review api: a blind confirmation never returns the offer position it resolved to', async () => {
  // Nothing touched the blind *decide* response before this test existed, which
  // is how the leak survived. Three confirmed decisions recovered the whole
  // permutation on this fixture with salt `study-salt-2026` (true order 0,2,1).
  const salt = 'study-salt-2026';
  const order = blindSlotOrder(offeredChoice(), salt);
  assert.deepEqual([...order], [0, 2, 1], 'fixture ordering changed; the leak scenario needs rechecking');
  for (let slot = 0; slot < order.length; slot += 1) {
    const { status, body } = await post({
      kind: 'decide',
      recommendation: offeredChoice(),
      locale: 'en',
      mode: 'blind',
      now: NOW,
      currentFingerprints: FRESH_FINGERPRINTS,
      submission: {
        recommendationId: RECOMMENDATION_ID,
        target: { mode: 'blind', slotIndex: slot, blindingSalt: salt },
        verdict: 'accept',
        decidedAt: NOW,
        confirmation: { stage: 'confirmed', acknowledgedVerdict: 'accept', acknowledgedIndex: slot, confirmedAt: NOW },
      },
    });
    assert.equal(status, 200);
    assert.equal((body.outcome as Record<string, unknown>).status, 'confirmed');
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes('handoff'), `slot ${slot} returned write authority`);
    assert.ok(!serialised.includes('optionIndex'), `slot ${slot} returned an offer position`);
    // The resolved position must not appear even as a bare number under another
    // name: the only numbers in a confirmed blind response should be none.
    assert.ok(!/\d/.test(String((body.outcome as Record<string, unknown>).notice ?? '')));
  }
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

/* ── Totality: nothing reaches the caller as a throw ─────────────── */

const VALIDITY = { basisAt: '2026-08-19T10:00:00.000Z', expiresAt: '2026-08-19T11:00:00.000Z' };
const ONE_OBSERVED = [{
  kind: 'observed', nodeId: 'a', source: { kind: 'commitment', commitmentId: 'c', field: 'due_at' },
  claim: { kind: 'flag', value: true }, observedAt: null, valueFingerprint: 'f',
}];

/**
 * Recommendation bodies that used to escape `POST` as an unhandled `TypeError`.
 *
 * Every one of these was measured throwing, on both the `present` and the
 * `decide` path, before the boundary was made total. `HOSTILE_BODIES` above only
 * ever covered the *envelope* — `kind`, arrays, bare strings — so the test named
 * "every malformed envelope is reported rather than thrown" was green while this
 * entire class was broken. These are the class.
 *
 * The assertion is deliberately not "each returns 400". After #33's `3a8158b`,
 * ten of the twelve are *reported defects* and come back `200` with a
 * `NothingToReviewView` naming the code — which is the better answer and the one
 * this contract said it would give. What is asserted is the property that
 * actually matters: **no input reaches the caller as an exception**, and the
 * response is always one this surface's taxonomy describes.
 */
const HOSTILE_RECOMMENDATIONS: readonly { readonly name: string; readonly value: unknown }[] = [
  { name: 'a choice with no option list', value: { options: { kind: 'choice' } } },
  { name: 'a choice whose option list is null', value: { options: { kind: 'choice', options: null, excluded: [] } } },
  { name: 'a choice of nulls', value: { options: { kind: 'choice', options: [null, null], excluded: [] } } },
  { name: 'an unknown soleness kind', value: { options: { kind: 'nonsense' } } },
  { name: 'a sole survivor with no option', value: { options: { kind: 'sole_survivor', excluded: [] } } },
  { name: 'an only-candidate with no option', value: { options: { kind: 'only_candidate', attested: [] } } },
  { name: 'an option with a null action', value: { options: { kind: 'choice', excluded: [], options: [
      { optionIndex: 0, action: null, support: [{ code: 'OVERDUE', supportedBy: ['a'], detail: 'd' }], confidence: { value: 0.5, band: 'medium', basis: ['a'] } },
      { optionIndex: 1, action: null, support: [{ code: 'OVERDUE', supportedBy: ['a'], detail: 'd' }], confidence: { value: 0.5, band: 'medium', basis: ['a'] } },
    ] } } },
  { name: 'an option with no confidence', value: { options: { kind: 'choice', excluded: [], options: [
      { optionIndex: 0, action: { kind: 'do_now', commitmentId: 'c' }, support: [] },
      { optionIndex: 1, action: { kind: 'do_now', commitmentId: 'd' }, support: [] },
    ] } } },
  { name: 'excluded entries that are null', value: { options: { kind: 'choice', options: [], excluded: [null] } } },
  { name: 'evidence nodes of mixed junk', value: { evidence: { nodes: [null, 3, 'x'] }, options: { kind: 'choice', options: [], excluded: [] } } },
  { name: 'a derived node with no parents', value: { evidence: { nodes: [{ kind: 'derived', nodeId: 'a', rule: 'OVERDUE_FROM_DUE_AT', claim: { kind: 'flag', value: true } }] }, options: { kind: 'choice', options: [], excluded: [] } } },
  { name: 'a withheld outcome with junk reasons', value: { outcome: 'withheld', reasons: [null, 5] } },
];

function hostileRecommendation(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    recommendationId: 'r', scopeId: 's', version: 'v1', schema: 'recommendation-v1', inputDigest: 'd',
    validity: VALIDITY, evidence: { nodes: ONE_OBSERVED }, outcome: 'offered', ...patch,
  };
}

test('review api: no malformed recommendation reaches the caller as an exception', async () => {
  for (const hostile of HOSTILE_RECOMMENDATIONS) {
    const recommendation = hostileRecommendation(hostile.value as Record<string, unknown>);
    for (const shape of [presentBody({ recommendation }), decideBody({ recommendation })]) {
      let status = 0;
      let body: Record<string, unknown> = {};
      try {
        const result = await post(shape);
        status = result.status;
        body = result.body;
      } catch (error) {
        assert.fail(`${hostile.name} threw ${(error as Error).constructor.name}: ${(error as Error).message}`);
      }
      assert.ok(status === 200 || status === 400, `${hostile.name} returned ${status}`);
      assert.equal(body.persisted, false, hostile.name);
      if (status === 400) {
        for (const code of findingCodes(body)) {
          assert.ok((REVIEW_FINDING_CODES as readonly string[]).includes(code), `${hostile.name}: ${code} is not in the taxonomy`);
        }
      } else if (body.kind === 'presented') {
        // A 200 must be a refusal to render, never a rendered offer built from junk.
        const view = body.view as Record<string, unknown>;
        assert.equal(view.mode, 'none', `${hostile.name} rendered an offer`);
        assert.equal(view.cause, 'defective', `${hostile.name} was not reported defective`);
      } else {
        assert.equal(body.kind, 'decided', hostile.name);
      }
    }
  }
});

/**
 * A deterministic mutation sweep over a *valid* recommendation.
 *
 * Hand-written hostile bodies only cover shapes somebody imagined, which is how
 * the original class was missed. This walks every path in a known-good
 * recommendation and replaces each one with `null`, `undefined`, `{}`, `[]`, `0`
 * and `''` in turn — several hundred single-site mutations — and asserts the
 * boundary never throws for any of them.
 *
 * Deterministic by construction: paths are enumerated in object order and the
 * substitutions are a fixed list, so there is no seed and no flake. One site at
 * a time, because a mutation sweep that changes several fields at once proves
 * only that *some* combination is handled.
 */
function mutationsOf(value: unknown, path: readonly string[] = []): { path: string[]; build: (replacement: unknown) => unknown }[] {
  const out: { path: string[]; build: (replacement: unknown) => unknown }[] = [];
  const replaceAt = (target: unknown, at: readonly string[], replacement: unknown): unknown => {
    if (at.length === 0) return replacement;
    if (Array.isArray(target)) {
      const copy = target.slice();
      copy[Number(at[0])] = replaceAt(target[Number(at[0])], at.slice(1), replacement);
      return copy;
    }
    const copy = { ...(target as Record<string, unknown>) };
    copy[at[0]] = replaceAt((target as Record<string, unknown>)[at[0]], at.slice(1), replacement);
    return copy;
  };
  const walk = (node: unknown, at: string[]): void => {
    if (at.length > 0) {
      const here = at.slice();
      out.push({ path: here, build: (replacement) => replaceAt(value, here, replacement) });
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) walk(node[index], [...at, String(index)]);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const key of Object.keys(node)) walk((node as Record<string, unknown>)[key], [...at, key]);
    }
  };
  walk(value, [...path]);
  return out;
}

test('review api: a single-site mutation of any field never throws', async () => {
  const valid = offeredChoice() as unknown as Record<string, unknown>;
  const sites = mutationsOf(valid);
  assert.ok(sites.length > 80, `expected a broad sweep, found ${sites.length} sites`);
  const substitutions: unknown[] = [null, undefined, {}, [], 0, ''];
  let checked = 0;
  for (const site of sites) {
    for (const replacement of substitutions) {
      const mutated = site.build(replacement);
      // Both entry points. `decide` runs everything `present` runs and then
      // `checkRecommendationDecision` on top, so a site that is safe to render
      // is not automatically safe to decide against.
      for (const shape of [presentBody({ recommendation: mutated }), decideBody({ recommendation: mutated })]) {
        let status = 0;
        let body: Record<string, unknown> = {};
        try {
          const result = await post(shape);
          status = result.status;
          body = result.body;
        } catch (error) {
          assert.fail(`mutating ${site.path.join('.')} to ${JSON.stringify(replacement) ?? 'undefined'} threw ${(error as Error).message}`);
        }
        assert.ok(status === 200 || status === 400, `${site.path.join('.')} returned ${status}`);
        assert.equal(body.persisted, false);
        assert.ok(!allKeys(body).has('handoff'), `${site.path.join('.')} produced write authority`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 500, `expected several hundred mutations, ran ${checked}`);
});

test('review api: an oversized recommendation is refused before it is processed', async () => {
  // #33's `3a8158b` made `resolveEvidenceRoots` iterative and removed the
  // quadratic term in the cycle detector, so the stack overflow at 8,000 nodes
  // and the 55.9s of CPU at 60,000 are both gone upstream — 150,000 nodes now
  // completes in about 150ms. The limit is still enforced, for a reason that is
  // about the route rather than the algorithm: App Router handlers have no
  // default body cap, so this endpoint would otherwise accept a body of
  // arbitrary size and allocate in proportion, unauthenticated.
  const nodes: unknown[] = [{ kind: 'observed', nodeId: 'n0', source: { kind: 'commitment', commitmentId: 'c', field: 'due_at' }, claim: { kind: 'flag', value: true }, observedAt: null, valueFingerprint: 'fp' }];
  for (let index = 1; index <= RECOMMENDATION_REVIEW_LIMITS.maxEvidenceNodes + 1; index += 1) {
    nodes.push({ kind: 'derived', nodeId: `n${index}`, rule: 'OVERDUE_FROM_DUE_AT', claim: { kind: 'flag', value: true }, derivedFrom: [`n${index - 1}`] });
  }
  const { status, body } = await post(presentBody({
    recommendation: hostileRecommendation({ evidence: { nodes }, options: { kind: 'choice', options: [], excluded: [] } }),
  }));
  assert.equal(status, 400);
  assert.deepEqual(findingCodes(body), ['RECOMMENDATION_TOO_LARGE']);

  const longTitle = await post(decideBody({}, {
    verdict: 'edit',
    editedTitle: 'x'.repeat(RECOMMENDATION_REVIEW_LIMITS.maxEditedTitleLength + 1),
  }));
  assert.equal(longTitle.status, 400);
  assert.ok(findingCodes(longTitle.body).includes('EDIT_TITLE_TOO_LONG'));
});

test('review api: a blind presentation carries only allow-listed fields on the wire', () => {
  const outcome = handleReviewRequest(presentBody({ mode: 'blind', blindingSalt: SALT }));
  const allowed = new Set<string>(BLIND_VIEW_ALLOWED_FIELDS);
  const serialised = JSON.parse(JSON.stringify((outcome.response as { view: unknown }).view));
  for (const key of Array.from(allKeys(serialised))) {
    assert.ok(allowed.has(key), `the wire format carries an un-allowed field: ${key}`);
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
