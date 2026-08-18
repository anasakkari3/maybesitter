/**
 * Decision store tests (Sprint 05, issue #21).
 *
 * The store is where reviewer judgments live before #22 fits anything to them,
 * so its failure modes are the ones that quietly corrupt evidence rather than
 * the ones that throw:
 *
 *  - **Disagreement collapsed into one row.** Averaging or last-write-wins
 *    destroys information exactly where it carries the most: two reviewers who
 *    disagree usually mean the rubric is ambiguous there, and a collapsed row
 *    hides that fact about the rubric.
 *  - **Backends drifting.** Every semantic assertion below runs against both the
 *    file and the in-memory backend from one table. The sibling alpha stores
 *    duplicated their logic per backend and their in-memory prune() drifted into
 *    a no-op; a test store that behaves differently from a production store is
 *    a test that proves nothing.
 *  - **Data that outlives a deletion.** A corrupt or half-written file still
 *    holds a reviewer's text, so deletion has to reach further than reading
 *    does. Two real gaps of exactly this kind were found in the runtime memory
 *    store, which is why the sweep is asserted rather than assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createFileDecisionStore,
  createInMemoryDecisionStore,
  DECISION_FILE_EXT,
  type DecisionStore,
} from '../../lib/priority/annotation/decisionStore.ts';
import {
  createReviewedDecision,
  decisionIdFor,
  isReviewedDecision,
  type CreateDecisionInput,
} from '../../lib/priority/annotation/reviewedDecision.ts';
import { CALIBRATION_SCHEMA_VERSION } from '../../src/contracts/v1/calibrationContracts.ts';

const AT = '2026-08-19T09:00:00.000Z';

function inputOf(overrides: Partial<CreateDecisionInput> = {}): CreateDecisionInput {
  return {
    pairId: 'ps-ar-light-01',
    reviewerId: 'rev-a',
    verdict: 'left',
    rationale: 'C1 — left is overdue and right is not',
    hardConstraintFlag: false,
    decidedAt: AT,
    ...overrides,
  };
}

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'ms-annotation-store-'));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One table, both backends. Any behaviour asserted here is asserted of both, so
 * the two cannot drift.
 */
const BACKENDS: readonly (readonly [string, (run: (store: DecisionStore) => void) => void])[] = [
  ['in-memory', (run) => run(createInMemoryDecisionStore())],
  ['file', (run) => withTempDir((dir) => run(createFileDecisionStore({ dataDir: dir })))],
];

for (const [backend, withStore] of BACKENDS) {
  test(`${backend}: an appended decision reads back exactly as it was written`, () => {
    withStore((store) => {
      const written = store.append(inputOf());

      assert.equal(written.version, CALIBRATION_SCHEMA_VERSION);
      assert.equal(written.decisionId, decisionIdFor('ps-ar-light-01', 'rev-a'));
      assert.deepEqual(store.get(written.decisionId), written);
      assert.deepEqual(store.list(), [written]);
    });
  });

  test(`${backend}: the store is append-only — a second write under one id is refused`, () => {
    withStore((store) => {
      store.append(inputOf());

      assert.throws(() => store.append(inputOf({ verdict: 'right' })), /already/);
      assert.equal(store.list().length, 1);
      assert.equal(store.list()[0].verdict, 'left');
    });
  });

  test(`${backend}: one reviewer cannot decide the same pair twice under a different id`, () => {
    withStore((store) => {
      store.append(inputOf());

      assert.throws(
        () => store.append(inputOf({ verdict: 'right', decisionId: 'dec_second-take' })),
        /already decided/,
      );
      assert.equal(store.list().length, 1);
    });
  });

  test(`${backend}: two reviewers who disagree produce two rows and one retained conflict`, () => {
    withStore((store) => {
      const first = store.append(inputOf({ reviewerId: 'rev-a', verdict: 'left' }));
      const second = store.append(inputOf({ reviewerId: 'rev-b', verdict: 'right' }));

      // Both rows survive: never an average, never last-write-wins.
      assert.equal(store.list().length, 2);
      assert.deepEqual(
        store.listByPair('ps-ar-light-01').map((decision) => decision.verdict).sort(),
        ['left', 'right'],
      );

      const conflicts = store.conflicts();
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].pairId, 'ps-ar-light-01');
      assert.deepEqual(conflicts[0].decisionIds.slice().sort(), [first.decisionId, second.decisionId].sort());
      assert.deepEqual(conflicts[0].verdicts.slice().sort(), ['left', 'right']);
    });
  });

  test(`${backend}: reviewers who agree produce no conflict`, () => {
    withStore((store) => {
      store.append(inputOf({ reviewerId: 'rev-a', verdict: 'tie' }));
      store.append(inputOf({ reviewerId: 'rev-b', verdict: 'tie' }));

      assert.deepEqual(store.conflicts(), []);
      assert.equal(store.list().length, 2);
    });
  });

  test(`${backend}: an abstention beside a firm verdict is retained but is not a conflict`, () => {
    withStore((store) => {
      store.append(inputOf({ reviewerId: 'rev-a', verdict: 'left' }));
      store.append(inputOf({ reviewerId: 'rev-b', verdict: 'unresolved' }));

      // Sprint 04's rule for `unresolved`, applied unchanged: an abstention is
      // neither agreement nor disagreement. Calling it a conflict would penalise
      // a reviewer for correctly following the rubric's abstention rules.
      assert.deepEqual(store.conflicts(), []);
      assert.equal(store.listByPair('ps-ar-light-01').length, 2);
    });
  });

  test(`${backend}: a decision with no reviewerId cannot be constructed, even when cast`, () => {
    withStore((store) => {
      const forged = {
        pairId: 'ps-ar-light-01',
        verdict: 'left',
        rationale: 'C1',
        hardConstraintFlag: false,
        decidedAt: AT,
      } as unknown as CreateDecisionInput;

      assert.throws(() => store.append(forged), /reviewerId/);
      assert.equal(store.list().length, 0);
    });
  });

  test(`${backend}: a decision with no decidedAt cannot be constructed, even when cast`, () => {
    withStore((store) => {
      const forged = { ...inputOf(), decidedAt: undefined } as unknown as CreateDecisionInput;
      const alsoForged = { ...inputOf(), decidedAt: 'last tuesday' } as unknown as CreateDecisionInput;

      assert.throws(() => store.append(forged), /decidedAt/);
      assert.throws(() => store.append(alsoForged), /decidedAt/);
      assert.equal(store.list().length, 0);
    });
  });

  test(`${backend}: extra properties on a forged input have nowhere to land`, () => {
    withStore((store) => {
      const forged = {
        ...inputOf(),
        version: 'attacker-chosen',
        provenance: 'human_reviewed',
      } as unknown as CreateDecisionInput;

      const written = store.append(forged);

      assert.equal(written.version, CALIBRATION_SCHEMA_VERSION);
      assert.equal((written as unknown as Record<string, unknown>).provenance, undefined);
    });
  });

  test(`${backend}: an id that could name a path outside the store is refused`, () => {
    withStore((store) => {
      for (const decisionId of ['dec_../../etc/passwd', '../../etc/passwd', 'dec_a/b', 'dec_..', '']) {
        assert.throws(
          () => store.append(inputOf({ decisionId })),
          /decisionId/,
          `append accepted the unsafe id ${JSON.stringify(decisionId)}`,
        );
      }
      assert.equal(store.get('../../etc/passwd'), null);
      assert.equal(store.remove('../../etc/passwd'), false);
      assert.equal(store.list().length, 0);
    });
  });

  test(`${backend}: Arabic and Hebrew rationale text round-trips unchanged`, () => {
    withStore((store) => {
      const arabic = 'المعيار C1 — الطرف الأيسر متأخر عن موعده والآخر ليس كذلك';
      const hebrew = 'קריטריון C2 — הצד עם המועד גובר על הלא-מתוזמן';

      const first = store.append(inputOf({ reviewerId: 'rev-ar', rationale: arabic }));
      const second = store.append(
        inputOf({ pairId: 'ps-he-light-01', reviewerId: 'rev-he', rationale: hebrew }),
      );

      assert.equal(store.get(first.decisionId)?.rationale, arabic);
      assert.equal(store.get(second.decisionId)?.rationale, hebrew);
      assert.equal(
        Buffer.from(store.get(first.decisionId)?.rationale ?? '', 'utf8').equals(Buffer.from(arabic, 'utf8')),
        true,
        'the rationale must survive as the same bytes, not a normalised look-alike',
      );
    });
  });
}

/* ── File backend only ──────────────────────────────────────────── */

test('file: a decision is written as UTF-8 and holds its non-Latin text literally', () => {
  withTempDir((dir) => {
    const store = createFileDecisionStore({ dataDir: dir });
    const arabic = 'المعيار C1 — متأخر';
    const written = store.append(inputOf({ rationale: arabic }));

    const onDisk = readFileSync(join(dir, `${written.decisionId}${DECISION_FILE_EXT}`), 'utf8');

    assert.ok(onDisk.includes(arabic), 'the stored file must not escape or transliterate the rationale');
    assert.equal(isReviewedDecision(JSON.parse(onDisk) as unknown), true);
  });
});

test('file: a corrupt decision file is skipped rather than fatal', () => {
  withTempDir((dir) => {
    const store = createFileDecisionStore({ dataDir: dir });
    const good = store.append(inputOf());

    writeFileSync(join(dir, `dec_truncated${DECISION_FILE_EXT}`), '{"version":"priority-calibra');
    writeFileSync(join(dir, `dec_wrong-schema${DECISION_FILE_EXT}`), '{"version":"v0","decisionId":"dec_x"}');

    assert.deepEqual(store.list(), [good], 'one damaged file must not deny access to the rest');
    assert.equal(store.get('dec_truncated'), null);
  });
});

test('file: a leftover temp file from a crashed write is never read as a decision', () => {
  withTempDir((dir) => {
    const store = createFileDecisionStore({ dataDir: dir });
    const good = store.append(inputOf());
    const orphan = createReviewedDecision(inputOf({ reviewerId: 'rev-crashed' }));
    writeFileSync(join(dir, `${orphan.decisionId}${DECISION_FILE_EXT}.9999.tmp`), JSON.stringify(orphan));

    assert.deepEqual(store.list(), [good]);
  });
});

test('file: deleting a reviewer removes their corrupt and half-written files too', () => {
  withTempDir((dir) => {
    const store = createFileDecisionStore({ dataDir: dir });
    store.append(inputOf({ reviewerId: 'rev-a' }));
    store.append(inputOf({ pairId: 'ps-he-light-01', reviewerId: 'rev-a' }));
    const other = store.append(inputOf({ reviewerId: 'rev-b' }));

    // A write truncated by a crash: too damaged to parse, but it still holds the
    // reviewer's text and still says whose it is.
    writeFileSync(
      join(dir, `dec_damaged${DECISION_FILE_EXT}`),
      '{"version":"priority-calibration-v1","reviewerId":"rev-a","rationale":"C1 — ',
    );
    // And a temp file the rename never reached.
    writeFileSync(
      join(dir, `dec_ps-x__rev-a${DECISION_FILE_EXT}.4242.tmp`),
      JSON.stringify(createReviewedDecision(inputOf({ pairId: 'ps-x', reviewerId: 'rev-a' }))),
    );

    const removed = store.deleteReviewer('rev-a');

    assert.equal(removed, 4, 'two records, one corrupt file and one temp file all belonged to rev-a');
    assert.deepEqual(store.list(), [other]);
    const residue = readdirSync(dir).filter((entry) => entry.includes('rev-a') || entry.includes('damaged'));
    assert.deepEqual(residue, [], `files attributable to rev-a survived deletion: ${residue.join(', ')}`);
  });
});

test('file: a file too damaged to name an owner is left in place', () => {
  withTempDir((dir) => {
    const store = createFileDecisionStore({ dataDir: dir });
    writeFileSync(join(dir, `dec_anonymous${DECISION_FILE_EXT}`), 'not json at all');

    assert.equal(store.deleteReviewer('rev-a'), 0);
    assert.equal(readdirSync(dir).length, 1, 'deleting one reviewer must not destroy an unattributable file');
  });
});

test('file: two stores over the same directory see the same decisions', () => {
  withTempDir((dir) => {
    const first = createFileDecisionStore({ dataDir: dir });
    const written = first.append(inputOf());

    const second = createFileDecisionStore({ dataDir: dir });

    assert.deepEqual(second.get(written.decisionId), written);
  });
});
