/**
 * «حاضر؟» is held only while the person's prep edit could not be carried
 * (Task A inspection r4–r6): never by a field that sends nothing.
 */
import { describe, expect, it } from '@jest/globals';
import { readinessLocked } from '../ImpactBlock';
import type { CaptureProposalItem } from '../../../api/schemas/capture';

const prep = { itemId: 'prep-1', generated: { sourceItemId: 'src-1' } } as unknown as CaptureProposalItem;

describe('readinessLocked', () => {
  it('is free with no edit, an empty edit, or only a removed place reminder (M4B-R6-002)', () => {
    expect(readinessLocked([prep], {}, null, 'src-1')).toBe(false);
    expect(readinessLocked([prep], { 'prep-1': {} }, null, 'src-1')).toBe(false);
    expect(readinessLocked([prep], { 'prep-1': { locationTrigger: null } }, null, 'src-1')).toBe(false);
  });

  it('holds for an edit that cannot be carried', () => {
    expect(readinessLocked([prep], { 'prep-1': { priority: 'high' } }, 'conv-1', 'src-1')).toBe(true);
    expect(readinessLocked([prep], { 'prep-1': { title: 'x' } }, null, 'src-1')).toBe(true);
  });

  it('does not hold for a title or time edit inside a chat', () => {
    expect(readinessLocked([prep], { 'prep-1': { title: 'x', localDateTime: '2030-01-01T10:00' } }, 'conv-1', 'src-1')).toBe(false);
  });
});
