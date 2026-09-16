import { describe, expect, it } from '@jest/globals';
import table from '../__fixtures__/mustRingIdentifier.json';
import { mustRingIdentifier } from '../mustRingIdentifier';
import { parseRequestIdentifier, requestIdentifier } from '../policy';

/**
 * The Must ring identifier, phone side (#198 review F2). The table is shared
 * with the server's `tests/reminders/mustRingIdentifier.test.ts`, so the local
 * request and the backup push are named the same thing on both sides.
 */
describe('the Must ring identifier', () => {
  it.each(table.cases.map(c => [c.commitmentId.slice(0, 24), c] as const))('%s', (_name, c) => {
    expect(mustRingIdentifier(c.commitmentId)).toBe(c.identifier);
    expect(requestIdentifier(c.commitmentId, 'strong')).toBe(c.identifier);
    expect(c.identifier.length).toBeLessThanOrEqual(64);
    // The engine still recognises it as one of its own requests.
    expect(parseRequestIdentifier(c.identifier)?.stage).toBe('strong');
  });

  it('leaves the gentle stages named as they were', () => {
    const long = 'x'.repeat(128);
    expect(requestIdentifier(long, 'soft')).toBe(`${long}:soft`);
  });
});
