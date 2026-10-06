/**
 * M2a contract foundation (audit 2026-10-06): `endTime` on an item and
 * `understood` on a proposal are optional and tolerant — a bad value reads as
 * absent instead of failing the whole answer — and the lines are only used when
 * they describe exactly this proposal.
 */
import { describe, expect, it } from '@jest/globals';
import { captureProposalSchema, usableUnderstood } from '../schemas/capture';

const base = {
  version: 'v1', proposalId: 'p1', status: 'proposed',
  items: [{ itemId: 'i1', title: 'Meeting', resolvedTime: '2026-10-07T13:00:00.000Z', needsClarification: false }],
  seeds: [{ seedItemId: 's1', kind: 'consideration', summary: 'travel next summer' }],
};

describe('endTime', () => {
  it('keeps a valid end and reads an invalid one as absent', () => {
    const ok = captureProposalSchema.parse({ ...base, items: [{ ...base.items[0], endTime: '2026-10-07T17:00:00.000Z' }] });
    expect(ok.items[0]!.endTime).toBe('2026-10-07T17:00:00.000Z');
    for (const endTime of ['tonight', '2026-10-07', '2026-10-07T17:00:00', '2026-10-07T13:00:00.000Z', '2026-10-07T12:00:00.000Z']) {
      // not an instant, a bare date, no offset, equal to the start, before the start
      const bad = captureProposalSchema.parse({ ...base, items: [{ ...base.items[0], endTime }] });
      expect(bad.items[0]!.endTime).toBeUndefined();
      expect(bad.items[0]!.title).toBe('Meeting');
    }
    const untimed = captureProposalSchema.parse({ ...base, items: [{ ...base.items[0], resolvedTime: null, endTime: '2026-10-07T17:00:00.000Z' }] });
    expect(untimed.items[0]!.endTime).toBeUndefined();
    const allDay = captureProposalSchema.parse({ ...base, items: [{ ...base.items[0], allDayEvent: true, endTime: '2026-10-07T17:00:00.000Z' }] });
    expect(allDay.items[0]!.endTime).toBeUndefined();
    const overnight = captureProposalSchema.parse({ ...base, items: [{ ...base.items[0], resolvedTime: '2026-10-07T19:00:00.000Z', endTime: '2026-10-08T01:00:00.000Z' }] });
    expect(overnight.items[0]!.endTime).toBe('2026-10-08T01:00:00.000Z');
    expect(captureProposalSchema.parse(base).items[0]!.endTime).toBeUndefined();
  });
});

describe('understood', () => {
  const lines = [
    { kind: 'commitment', itemId: 'i1', text: 'Meeting tomorrow 16:00–20:00' },
    { kind: 'consideration', seedItemId: 's1', text: 'You are thinking about travelling next summer' },
  ];

  it('parses well-formed lines and uses them when they cover the proposal exactly', () => {
    const parsed = captureProposalSchema.parse({ ...base, understood: lines });
    expect(parsed.understood).toHaveLength(2);
    expect(usableUnderstood(parsed)).toHaveLength(2);
  });

  it.each([
    ['not an array', 'five things'],
    ['an unknown kind', [{ kind: 'habit', itemId: 'i1', text: 'x' }]],
    ['an overlong line', [{ kind: 'commitment', itemId: 'i1', text: 'x'.repeat(161) }]],
    ['an extra field', [{ kind: 'commitment', itemId: 'i1', text: 'x', saved: true }]],
  ])('reads %s as no list, and the rest of the answer still parses', (_label, value) => {
    const parsed = captureProposalSchema.parse({ ...base, understood: value });
    expect(parsed.understood).toBeUndefined();
    expect(parsed.items).toHaveLength(1);
  });

  it.each([
    ['a missing seed', [lines[0]]],
    ['an unknown item', [{ kind: 'commitment', itemId: 'nope', text: 'x' }, lines[1]]],
    ['a duplicated item', [lines[0], lines[0], lines[1]]],
    ['a seed under the wrong kind', [lines[0], { kind: 'idea', seedItemId: 's1', text: 'x' }]],
  ])('does not use lines with %s', (_label, value) => {
    const parsed = captureProposalSchema.parse({ ...base, understood: value });
    expect(usableUnderstood(parsed)).toBeUndefined();
  });

  it('is absent from an older server, and nothing is used', () => {
    expect(usableUnderstood(captureProposalSchema.parse(base))).toBeUndefined();
  });
});
