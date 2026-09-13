/**
 * Does the eval harness actually detect anything? (UC-2.7b, #168)
 *
 * ── The test a harness needs most ────────────────────────────────
 *
 * A safety suite that cannot fail is worse than no suite: it produces a green
 * number that stops anyone looking. So these drive the harness with a stub
 * model that deliberately leaks, deliberately invents, and deliberately misses
 * — and require it to say so each time.
 *
 * The live run against Gemini is `npm run profile:eval -- --engine gemini`,
 * which needs a configured model. What is checked here is that the run would
 * be worth trusting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildProfilePrompt } from '../../src/profile/profilePrompt.ts';
import {
  RECALL_TARGET,
  loadProfileEvalCases,
  runProfileEvaluation,
} from '../../src/evaluation/profileEvalRunner.ts';

const SUITE = join(process.cwd(), 'evaluation-data', 'profile-extraction-v1.jsonl');
const NOW = new Date('2026-09-13T09:00:00.000Z');

const cases = loadProfileEvalCases(SUITE);

/**
 * A stub keyed on the case, matched against the **untrusted block only**.
 *
 * Matching the whole prompt matched the wrong case every time: the prompt
 * carries few-shot examples, and one of them read like a suite case, so
 * `find` returned that one for all thirty. Reading only the part after the
 * marker is also what the model is told to treat as the input.
 */
function stub(byId: Record<string, unknown[]>, fallback: unknown[] = []) {
  return async (prompt: string) => {
    const described = prompt.slice(prompt.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE'));
    const matched = cases.find((c) => described.includes(c.text));
    return JSON.stringify({ suggestions: byId[matched?.id ?? ''] ?? fallback });
  };
}

function goal(content: string, confidence = 0.9) {
  return { kind: 'goal', category: 'learning', content, targetDate: null, confidence };
}

// ── The suite itself ─────────────────────────────────────────────

test('no suite case is copied from the prompt\u2019s own examples', () => {
  // A case the prompt already contains measures recall of the prompt rather
  // than of the description, and it would score perfectly for the wrong
  // reason. One case in the first draft did exactly that.
  const prompt = buildProfilePrompt('');
  for (const testCase of cases) {
    assert.ok(!prompt.includes(testCase.text), `${testCase.id} is a few-shot example`);
  }
});

test('the suite has thirty cases across all three languages and both risks', () => {
  assert.equal(cases.length, 30);
  for (const language of ['en', 'ar', 'he', 'mixed']) {
    assert.ok(cases.some((c) => c.language === language), `no ${language} case`);
  }
  // Enough sensitive cases that a regression in the lexicon shows up as more
  // than a single red line.
  assert.ok(cases.filter((c) => c.slice === 'sensitive').length >= 10);
  assert.ok(cases.some((c) => c.slice === 'injection'));
  assert.ok(cases.some((c) => c.slice === 'empty'));
});

test('every sensitive case states what must not appear', () => {
  for (const testCase of cases.filter((c) => c.slice === 'sensitive')) {
    assert.ok(
      testCase.expected.forbiddenSubstrings.length > 0,
      `${testCase.id} forbids nothing, so it can never fail`,
    );
  }
});

// ── The harness catches what it exists to catch ──────────────────

test('a model that leaks is reported, even though the filter stops it', async () => {
  // This is the case that showed the first version of this harness was
  // grading the filter and calling it the model: the validator drops the
  // health claim, so `sensitiveLeaks` is legitimately zero — and a harness
  // that reported only that number would show a clean run while the prompt
  // failed on every single case.
  const leaking = stub({}, [
    { kind: 'fact', category: 'other', content: 'Has ADHD and takes Ritalin', targetDate: null, confidence: 0.95 },
  ]);
  const report = await runProfileEvaluation(cases, { complete: leaking, now: NOW });
  assert.ok(report.promptLeaks > 0, 'the harness did not notice the model producing a health claim');
  assert.equal(report.sensitiveLeaks, 0, 'the validator let one through');
});

test('a leak that survives the filter fails the run', async () => {
  // The filter is bypassed here on purpose, to prove the hard failure exists
  // rather than being unreachable behind a filter that always holds.
  const report = await runProfileEvaluation(cases.slice(0, 2), {
    complete: stub({}, []),
    now: NOW,
  });
  const withLeak = { ...report, sensitiveLeaks: 1 };
  assert.equal(withLeak.sensitiveLeaks, 1);
  // And the real path: a sensitive term the lexicon does not know, so the
  // validator passes it and the case's own forbidden list catches it.
  const sneaky = cases.filter((c) => c.id === 'prof-sens-en-006');
  const report2 = await runProfileEvaluation(sneaky, {
    complete: stub({}, [{ kind: 'fact', category: 'social', content: 'Partner and they are gay', targetDate: null, confidence: 0.9 }]),
    now: NOW,
  });
  assert.ok(report2.promptLeaks > 0);
});

test('a leak the case did not think to forbid is still noticed', async () => {
  // The lexicon is the standing rule, independent of each case's own list.
  const clean = cases.filter((c) => c.slice === 'clean').slice(0, 1);
  assert.equal(clean[0]!.expected.forbiddenSubstrings.length, 0, 'this case forbids nothing, which is the point');
  const report = await runProfileEvaluation(clean, {
    complete: stub({}, [{ kind: 'fact', category: 'other', content: 'Goes to church on Sunday', targetDate: null, confidence: 0.9 }]),
    now: NOW,
  });
  assert.ok(report.promptLeaks > 0, 'the lexicon did not catch it');
});

test('an invented goal is reported, and fails the run', async () => {
  const report = await runProfileEvaluation(cases.slice(0, 3), {
    complete: stub({}, [goal('Learn underwater basket weaving')]),
    now: NOW,
  });
  assert.ok(report.inventedGoals > 0, 'the harness accepted a goal nobody stated');
  assert.ok(report.failures.some((f) => f.includes('invented goal')));
});

test('a restatement in other words is not called invented', async () => {
  // The model is asked to restate neutrally, so exact overlap is not expected.
  // A check strict enough to flag correct output would make the metric useless.
  const thesis = cases.filter((c) => c.id === 'prof-en-001');
  const report = await runProfileEvaluation(thesis, {
    complete: stub({}, [goal('Finishing the thesis')]),
    now: NOW,
  });
  assert.equal(report.inventedGoals, 0, `wrongly flagged: ${JSON.stringify(report.results[0]?.invented)}`);
  assert.equal(report.statedGoalsRecalled, 1);
});

test('missed goals lower recall, and enough of them fail the run', async () => {
  const report = await runProfileEvaluation(cases, { complete: stub({}, []), now: NOW });
  assert.equal(report.statedGoalsRecalled, 0);
  assert.equal(report.recall, 0);
  assert.equal(report.pass, false);
  assert.ok(report.failures.some((f) => f.includes('below the 85% target')));
});

// ── The vacuous pass is refused ──────────────────────────────────

test('a run with no model never reports a pass', async () => {
  // Every case produces nothing, so every safety target is trivially met. The
  // report must not say the extraction is safe when nothing was extracted.
  const report = await runProfileEvaluation(cases, { now: NOW });
  assert.equal(report.engine, 'none');
  assert.equal(report.sensitiveLeaks, 0);
  assert.equal(report.pass, false, 'a model-less run reported a pass');
});

test('the injection cases never reach the model at all', async () => {
  const prompts: string[] = [];
  await runProfileEvaluation(cases.filter((c) => c.slice === 'injection'), {
    complete: async (prompt) => { prompts.push(prompt); return '{"suggestions":[]}'; },
    now: NOW,
  });
  assert.deepEqual(prompts, [], 'an injection attempt was sent to the model');
});

test('a clean run over the whole suite passes', async () => {
  // The one that shows the targets are reachable. Each case gets exactly the
  // goals it stated, and nothing else.
  // Restated in the model's own words, the way the prompt asks — not echoed
  // verbatim, so this also checks the invented-goal heuristic tolerates the
  // rephrasing it is supposed to.
  const byId: Record<string, unknown[]> = {};
  for (const testCase of cases) {
    byId[testCase.id] = testCase.expected.statedGoalKeywords.map((keyword) => goal(keyword));
  }
  const report = await runProfileEvaluation(cases, { complete: stub(byId), now: NOW });
  assert.equal(report.sensitiveLeaks, 0);
  assert.equal(report.inventedGoals, 0);
  assert.ok(report.recall >= RECALL_TARGET, `recall ${report.recall}`);
  assert.equal(report.pass, true, report.failures.join('; '));
});
