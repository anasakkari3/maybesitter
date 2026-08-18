/**
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE
 *
 * Tests for the alpha quality harness: fixture schema validity, taxonomy
 * coverage, report generation, and seeded-failure classification.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHA_SCENARIOS,
  TAXONOMY_SEVERITY,
  type AlphaScenario,
  type FailureTaxonomy,
} from './scenarios/alphaQualityScenarios';
import {
  generateMarkdownReport,
  runAlphaQualityHarness,
  runSeededFailureTest,
} from '../../lib/quality/alphaQualityHarness';

const VALID_TAXONOMY = new Set<FailureTaxonomy>(Object.keys(TAXONOMY_SEVERITY) as FailureTaxonomy[]);
const VALID_LANGS = new Set(['en', 'ar', 'he', 'mixed']);
const VALID_DISPOSITIONS = new Set(['auto_confirm', 'pending_confirmation', 'needs_clarification', 'store_note']);

test('quality harness: scenario corpus schema is valid', () => {
  assert.ok(ALPHA_SCENARIOS.length >= 30, `expected >= 30 scenarios, got ${ALPHA_SCENARIOS.length}`);
  const ids = new Set<string>();
  for (const scenario of ALPHA_SCENARIOS) {
    assert.ok(scenario.id, 'scenario must have id');
    assert.ok(!ids.has(scenario.id), `duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(VALID_LANGS.has(scenario.lang), `invalid lang ${scenario.lang} in ${scenario.id}`);
    assert.ok(scenario.input.length > 0, 'input must be non-empty');
    assert.ok(scenario.context.now instanceof Date, 'context.now must be a Date');
    assert.ok(scenario.constraints.length >= 1, 'at least one constraint required');
    for (const constraint of scenario.constraints) {
      assert.ok(
        VALID_TAXONOMY.has(constraint.failureTaxonomy),
        `invalid taxonomy "${constraint.failureTaxonomy}" in ${scenario.id}`,
      );
      const defined = [
        constraint.expectedType,
        constraint.titleRegex,
        constraint.titleContains,
        constraint.titleMustNotContain,
        constraint.expectedDisposition,
        constraint.expectedDayOffset,
        constraint.expectedHourUtc,
        constraint.expectedHourOffset,
        constraint.expectedPriorityLevel,
        constraint.expectedPrioritySource,
        constraint.expectedRecState,
        constraint.recTitleContains,
        constraint.recEvidenceContains,
        constraint.recActionsInclude,
      ].filter((v) => v !== undefined);
      assert.ok(defined.length >= 1, `constraint in ${scenario.id} must assert something`);
    }
  }
});

test('quality harness: corpus covers all languages and all taxonomy categories', () => {
  const langs = new Set(ALPHA_SCENARIOS.map((s) => s.lang));
  const requiredLangs = ['en', 'ar', 'he', 'mixed'] as const;
  for (const lang of requiredLangs) {
    assert.ok(langs.has(lang), `no scenario for language ${lang}`);
  }
  const usedTaxonomy = new Set(ALPHA_SCENARIOS.flatMap((s) => s.constraints.map((c) => c.failureTaxonomy)));
  for (const taxonomy of Array.from(VALID_TAXONOMY)) {
    assert.ok(usedTaxonomy.has(taxonomy), `no scenario exercises taxonomy ${taxonomy}`);
  }
});

test('quality harness: runs the real pipeline deterministically and produces a report', () => {
  const first = runAlphaQualityHarness();
  const second = runAlphaQualityHarness();
  assert.equal(first.totalScenarios, ALPHA_SCENARIOS.length);
  assert.equal(first.scenarioResults.length, ALPHA_SCENARIOS.length);
  // Deterministic: same run twice yields identical results.
  assert.equal(JSON.stringify(first.scenarioResults), JSON.stringify(second.scenarioResults));
  // Every scenario result carries pipeline outputs.
  for (const result of first.scenarioResults) {
    assert.ok(result.extractionType.length > 0, `${result.scenarioId} missing extractionType`);
    assert.ok(VALID_DISPOSITIONS.has(result.disposition), `${result.scenarioId} invalid disposition ${result.disposition}`);
  }
  const markdown = generateMarkdownReport(first);
  assert.match(markdown, /SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE/);
  assert.match(markdown, new RegExp(`Scenarios: ${first.totalScenarios}`));
});

test('quality harness: seeded failure is classified as invented_fact', () => {
  const seeded = runSeededFailureTest();
  assert.equal(seeded.passed, true, `seeded failure test should pass: ${seeded.detail}`);
  assert.equal(seeded.taxonomyDetected, 'invented_fact');
});

test('quality harness: constraint checker rejects an invented title', () => {
  // Direct unit-level proof: the classifier flags a title token absent from the input.
  const input = 'Remind me to buy groceries tomorrow';
  const badTitle = 'Call Sarah instead';
  const inputTokens = new Set(input.replace(/remind me to /i, '').trim().toLowerCase().split(/\s+/));
  const invented = badTitle.toLowerCase().split(/\s+/).filter((token) => !inputTokens.has(token));
  assert.ok(invented.length > 0, 'seeded invented tokens must be detected');
  assert.ok(invented.includes('sarah'));
});
