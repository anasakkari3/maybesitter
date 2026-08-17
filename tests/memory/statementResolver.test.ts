import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatement, scoreStatementMatch, type ResolvableStatement } from '../../src/domain/memory/statementResolver.ts';

function makeExisting(overrides: Partial<ResolvableStatement> = {}): ResolvableStatement {
  return { id: 'pref_1', scope: 'gym', statement: 'avoid gym three days in a row', ...overrides };
}

test('resolver: identical scope and text → high score, auto-link', () => {
  const decision = resolveStatement('gym', 'avoid gym three days in a row', [makeExisting()]);
  assert.equal(decision.action, 'link');
});

test('resolver: no existing statements → create new', () => {
  const decision = resolveStatement('gym', 'avoid gym three days in a row', []);
  assert.equal(decision.action, 'create_new');
});

test('resolver: same scope, unrelated text → create new (not auto-linked)', () => {
  const decision = resolveStatement('gym', 'the gym closes at 10pm on weekdays', [makeExisting()]);
  assert.equal(decision.action, 'create_new');
});

test('resolver: different scope, similar text → create new', () => {
  const decision = resolveStatement('wolt', 'avoid gym three days in a row', [makeExisting()]);
  assert.equal(decision.action, 'create_new');
});

test('resolver: partial text overlap in same scope → confirm_link band', () => {
  const decision = resolveStatement('gym', 'avoid gym three days straight', [makeExisting()]);
  assert.ok(decision.action === 'link' || decision.action === 'confirm_link');
});

test('resolver: score includes scope and text components', () => {
  const score = scoreStatementMatch('gym', 'avoid gym three days in a row', makeExisting());
  assert.equal(score.scopeScore, 1);
  assert.ok(score.textScore > 0.9);
  assert.ok(score.totalScore >= 0 && score.totalScore <= 1);
});
