/**
 * What the product is allowed to know about a football match.
 *
 * The boundary is deliberately narrow: an interval, two team names, a
 * competition and a status. No score, no lineup, no minute-by-minute. The
 * product cares about a match as a claim on somebody's evening, and a contract
 * that cannot express a score cannot leak one into a commitment title.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureContentHash, FIXTURE_BLOCK_MINUTES } from '../../src/contracts/v1/fixtureContracts.ts';

const BASE = {
  provider: 'football-data',
  providerMatchId: '419471',
  competition: 'PD',
  homeTeamId: '81',
  awayTeamId: '86',
  homeTeamName: 'FC Barcelona',
  awayTeamName: 'Real Madrid CF',
  kickoffUtc: '2026-10-25T19:00:00.000Z',
  status: 'scheduled' as const,
  venue: 'Camp Nou',
};

test('a match blocks two hours', () => {
  assert.equal(FIXTURE_BLOCK_MINUTES, 120);
});

test('the same match hashes the same way twice', () => {
  assert.equal(fixtureContentHash(BASE), fixtureContentHash({ ...BASE }));
});

test('a moved kickoff changes the hash', () => {
  const moved = { ...BASE, kickoffUtc: '2026-10-26T19:00:00.000Z' };
  assert.notEqual(fixtureContentHash(BASE), fixtureContentHash(moved));
});

test('a postponement changes the hash', () => {
  assert.notEqual(fixtureContentHash(BASE), fixtureContentHash({ ...BASE, status: 'postponed' }));
});

test('key order does not change the hash', () => {
  // The hash decides whether a user's commitment is rewritten tonight. If it
  // depended on the order a provider happened to serialise its JSON, every
  // fixture would look changed on some responses and unchanged on others.
  const reordered = Object.fromEntries(Object.entries(BASE).reverse()) as typeof BASE;
  assert.equal(fixtureContentHash(BASE), fixtureContentHash(reordered));
});
