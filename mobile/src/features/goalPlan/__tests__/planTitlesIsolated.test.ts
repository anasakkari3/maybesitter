import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

/**
 * M6b BB-07 (Codex M6B-R03, R2-002): every plan-step title PlanFlow draws goes
 * through `isolateQuoted`, because the server's template quotes the goal title
 * («{goal}») and a Latin end reorders inside an Arabic sentence. A census, so a
 * new screen in the flow cannot draw a raw title.
 */
describe('PlanFlow title census', () => {
  const source = readFileSync(join(__dirname, '..', 'PlanFlow.tsx'), 'utf8');
  it('draws no step or item title without isolateQuoted', () => {
    const raw = source.match(/<Txt[^>]*>\{(?:step\.title|item\.title|name|titleIn\([^)]*\)(?: \?\? '')?)\}<\/Txt>/g) ?? [];
    expect(raw).toEqual([]);
  });
  it('uses isolateQuoted on the draft, scheduling, confirm and result screens', () => {
    expect((source.match(/isolateQuoted\(/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });
});
