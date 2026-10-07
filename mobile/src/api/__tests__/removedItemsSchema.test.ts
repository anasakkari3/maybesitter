/** Contract v5 (M2b): `removedItems` is read tolerantly — a bad entry is dropped, never the answer. */
import { expect, it } from '@jest/globals';
import { captureProposalSchema } from '../schemas/capture';
import fixture from '../__fixtures__/capture.chatProposal.json';

const base = (fixture as { proposal: Record<string, unknown> }).proposal;

it('keeps well-formed entries and drops one with both ids, none, an unknown kind or no words', () => {
  const parsed = captureProposalSchema.parse({
    ...base,
    removedItems: [
      { itemId: 'a', kind: 'commitment', text: 'Call Mum' },
      { seedItemId: 'b', kind: 'idea', text: 'Learn pottery' },
      { itemId: 'c', seedItemId: 'd', kind: 'idea', text: 'both ids' },
      { kind: 'idea', text: 'no id' },
      { itemId: 'e', kind: 'chore', text: 'unknown kind' },
      { itemId: 'f', kind: 'idea', text: '' },
      // The id says which list it came from; a kind from the other list is a mismatch (M2B-A-R7-002).
      { seedItemId: 'g', kind: 'commitment', text: 'seed id, commitment kind' },
      { itemId: 'h', kind: 'idea', text: 'item id, seed kind' },
    ],
  });
  expect(parsed.removedItems).toEqual([
    { itemId: 'a', kind: 'commitment', text: 'Call Mum' },
    { seedItemId: 'b', kind: 'idea', text: 'Learn pottery' },
  ]);
});

it('reads a wrong value, or nothing usable, as none', () => {
  expect(captureProposalSchema.parse({ ...base, removedItems: 'x' }).removedItems).toBeUndefined();
  expect(captureProposalSchema.parse({ ...base, removedItems: [{ kind: 'idea' }] }).removedItems).toBeUndefined();
  expect(captureProposalSchema.parse(base).removedItems).toBeUndefined();
});

it('the route\'s own answers parse: one removed point, then brought back', () => {
  const removed = captureProposalSchema.parse(require('../__fixtures__/capture.chatRemovedLocked.json').proposal);
  expect(removed.removedItems).toHaveLength(1);
  const restored = captureProposalSchema.parse(require('../__fixtures__/capture.chatEditRestore.json').proposal);
  expect(restored.removedItems).toBeUndefined();
  const id = removed.removedItems![0]!.itemId ?? removed.removedItems![0]!.seedItemId;
  expect([...restored.items.map((item) => item.itemId), ...restored.seeds.map((seed) => seed.seedItemId)]).toContain(id);
});
