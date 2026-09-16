import test from 'node:test';
import assert from 'node:assert/strict';
import { listClubs, clubById } from '../../lib/football/clubs.ts';

test('the list is not empty and Barcelona is in it', () => {
  assert.ok(listClubs().length >= 12);
  assert.ok(listClubs().some((c) => c.clubId === 'barcelona'));
});

test('every club names itself in all three languages', () => {
  for (const club of listClubs()) {
    for (const lang of ['ar', 'he', 'en'] as const) {
      assert.ok(club.names[lang]?.trim(), `${club.clubId} is missing its ${lang} name`);
    }
  }
});

test('club ids are unique', () => {
  const ids = listClubs().map((c) => c.clubId);
    assert.equal(new Set(ids).size, ids.length);
});

test('provider team ids are unique', () => {
  // Two clubs pointing at one provider id would project one club's fixtures
  // onto the other's followers, and nothing downstream would notice.
  const ids = listClubs().map((c) => c.providerTeamId);
  assert.equal(new Set(ids).size, ids.length);
});

test('an unknown club id is null, not a throw', () => {
  assert.equal(clubById('not-a-club'), null);
});
