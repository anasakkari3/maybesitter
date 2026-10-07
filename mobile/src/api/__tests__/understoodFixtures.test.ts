/**
 * M2a across the two lanes: the server's own answers — fixtures written by the
 * route handlers — are summaries the app uses, not ones it silently drops.
 */
import { describe, expect, it } from '@jest/globals';
import { captureChatSchema, usableUnderstood } from '../schemas/capture';
import many from '../__fixtures__/capture.chatUnderstoodMany.json';
import consideration from '../__fixtures__/capture.chatConsideration.json';
import goal from '../__fixtures__/capture.chatGoalStatement.json';
import range from '../__fixtures__/capture.chatRange.json';

describe('the route\'s summaries reach the app', () => {
  it.each([
    ['five points, kinds interleaved', many, ['commitment', 'consideration', 'commitment', 'possible_goal', 'waiting_for']],
    ['a consideration alone', consideration, ['consideration']],
    ['a goal said as a wish', goal, ['possible_goal']],
    ['a range', range, ['commitment']],
  ])('%s', (_label, fixture, kinds) => {
    const proposal = captureChatSchema.parse(fixture).proposal!;
    expect(usableUnderstood(proposal)?.map((point) => point.kind)).toEqual(kinds);
  });

  it('a consideration or a wish is not a commitment card, and is not asked a time', () => {
    for (const fixture of [consideration, goal]) {
      const answer = captureChatSchema.parse(fixture);
      expect(answer.proposal!.items).toHaveLength(0);
      expect(answer.reply).not.toMatch(/إيمتى|أي وقت|الساعة/); // «إيمتى», «أي وقت», «الساعة»
    }
  });

  it('the range keeps its end', () => {
    const item = captureChatSchema.parse(range).proposal!.items[0]!;
    expect(Date.parse(item.endTime!) - Date.parse(item.resolvedTime!)).toBe(4 * 3_600_000);
  });
});
