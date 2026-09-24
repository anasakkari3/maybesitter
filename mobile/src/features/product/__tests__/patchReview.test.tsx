import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { strings } from '../../../i18n/strings';
import { planResponseSchema, type DailyPlan, type PendingPlanProposal } from '../../../api/schemas/plan';
import fixture from '../../../api/__fixtures__/plan.withProposal.json';
import { PatchReviewScreen, patchReasonKey } from '../ControlScreens';

/**
 * The continuous-replan review screen (#523).
 *
 * Two things it must never do, both named in #523's handoff and both shipped
 * by the first version of this screen: show the server's internal policy code
 * (`contains_removals`) as if it were copy, and list a protection the
 * patch *overrides* under the heading "what stays protected". The second is the
 * worse one — the `protections` field exists so that nobody accepts a move
 * over an hour they protected without being told.
 *
 * The proposal comes from `plan.withProposal.json`, which the fixture exporter
 * records from the real GET handler, so these cases are about the shape the
 * server actually sends rather than one written here.
 */

const recorded = planResponseSchema.parse(fixture);
const RECORDED_PLAN: DailyPlan = { ...recorded.plan, proposal: recorded.proposal ?? null };
const RECORDED_PROPOSAL = recorded.proposal!;

let mockPlan: DailyPlan | null = RECORDED_PLAN;
const mockAct = jest.fn();

jest.mock('../../../api/queries', () => ({
  usePlan: () => ({ data: mockPlan, isPending: false, error: null, refetch: jest.fn() }),
  usePlanAction: () => ({ mutate: mockAct, isPending: false, error: null }),
  // Imported by other screens in the same module; never rendered here.
  useHabits: () => ({ data: [], isPending: false, error: null, refetch: jest.fn() }),
  useCreateHabit: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useSetHabitStatus: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useDeleteHabit: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const show = () => render(
  <SafeAreaProvider initialMetrics={metrics}><AppProvider><PatchReviewScreen /></AppProvider></SafeAreaProvider>,
);

/** The bundle the provider rendered in, found by a string only that bundle has on screen. */
function language() {
  return Object.values(strings).find(bundle => screen.queryAllByText(bundle.xPatch).length > 0)!;
}

function withProposal(proposal: PendingPlanProposal): DailyPlan {
  return { ...RECORDED_PLAN, proposal };
}

beforeEach(() => {
  mockPlan = RECORDED_PLAN;
  mockAct.mockClear();
});
afterEach(cleanup);

describe('the reason', () => {
  it('is said as a sentence, never as the policy code the server sends', async () => {
    expect(RECORDED_PROPOSAL.reason).toBe('contains_removals');
    await show();
    const t = language();
    expect(screen.queryByText('contains_removals')).toBeNull();
    expect(screen.getByText(t.xPatchWhyRemovals)).toBeTruthy();
  });

  it('maps every reason the policy can propose with, and nothing else by accident', () => {
    expect(patchReasonKey('user_requires_confirmation')).toBe('xPatchWhyConfirm');
    expect(patchReasonKey('contains_removals')).toBe('xPatchWhyRemovals');
    expect(patchReasonKey('contains_additions')).toBe('xPatchWhyAdditions');
    expect(patchReasonKey('churn_exceeded_threshold')).toBe('xPatchWhyChurn');
    // A reason the server adds later reads as the generic sentence — and so
    // does a string that happens to name an Object.prototype member.
    expect(patchReasonKey('a_reason_added_later')).toBe('xPatchWhyOther');
    expect(patchReasonKey('toString')).toBe('xPatchWhyOther');
  });

  it('shows the generic sentence for an unknown reason instead of the raw value', async () => {
    mockPlan = withProposal({ ...RECORDED_PROPOSAL, reason: 'a_reason_added_later' });
    await show();
    expect(screen.queryByText('a_reason_added_later')).toBeNull();
    expect(screen.getByText(language().xPatchWhyOther)).toBeTruthy();
  });
});

describe('protections the patch overrides', () => {
  it('are disclosed in their own section, and are not listed as staying protected', async () => {
    const overridden = RECORDED_PROPOSAL.protections.find(protection => protection.overridden)!;
    expect(overridden).toBeTruthy();
    await show();
    const t = language();

    const disclosure = screen.getByTestId('patch-overridden');
    expect(within(disclosure).getByText(t.xOverridden)).toBeTruthy();
    expect(within(disclosure).getByText(t.xOverriddenBody)).toBeTruthy();
    expect(within(disclosure).getByTestId(`patch-protection-${overridden.blockId}`)).toBeTruthy();

    // Every protection in the recorded patch is overridden, so the heading
    // "what stays protected" has nothing true to say and is not drawn at all.
    expect(screen.queryByTestId('patch-kept')).toBeNull();
    expect(screen.queryByText(t.xProtected)).toBeNull();
  });

  it('keeps an untouched protection under "what stays protected", with no disclosure', async () => {
    const kept = { ...RECORDED_PROPOSAL.protections[0]!, overridden: false };
    mockPlan = withProposal({ ...RECORDED_PROPOSAL, protections: [kept] });
    await show();
    const t = language();
    expect(screen.queryByTestId('patch-overridden')).toBeNull();
    expect(within(screen.getByTestId('patch-kept')).getByTestId(`patch-protection-${kept.blockId}`)).toBeTruthy();
    expect(screen.getByText(t.xProtected)).toBeTruthy();
  });

  it('splits a mixed patch: the overridden block is disclosed, the kept one is not', async () => {
    const base = RECORDED_PROPOSAL.protections[0]!;
    const overridden = { ...base, blockId: 'block:over', overridden: true };
    const kept = { ...base, blockId: 'block:kept', overridden: false };
    mockPlan = withProposal({ ...RECORDED_PROPOSAL, protections: [overridden, kept] });
    await show();
    const disclosure = screen.getByTestId('patch-overridden');
    const keptSection = screen.getByTestId('patch-kept');
    expect(within(disclosure).queryByTestId('patch-protection-block:kept')).toBeNull();
    expect(within(disclosure).getByTestId('patch-protection-block:over')).toBeTruthy();
    expect(within(keptSection).queryByTestId('patch-protection-block:over')).toBeNull();
    expect(within(keptSection).getByTestId('patch-protection-block:kept')).toBeTruthy();
  });

  it('says a protected block the patch leaves unplaced is not in the new plan', async () => {
    const unplaced = { ...RECORDED_PROPOSAL.protections[0]!, proposedInterval: null, overridden: true };
    mockPlan = withProposal({ ...RECORDED_PROPOSAL, protections: [unplaced] });
    await show();
    const t = language();
    expect(within(screen.getByTestId('patch-overridden')).getByText(new RegExp(`${t.xAfter}: ${t.xUnplaced}$`))).toBeTruthy();
  });

  it('shows the protected time an override gives up, not only the proposed one', async () => {
    await show();
    const t = language();
    expect(within(screen.getByTestId('patch-overridden')).getByText(new RegExp(`^${t.xProtectedTime}: `))).toBeTruthy();
  });

  it('says a removed item is not in the new plan, rather than "not set"', async () => {
    expect(RECORDED_PROPOSAL.changes.some(change => change.kind === 'removed' && change.to === null)).toBe(true);
    await show();
    const t = language();
    expect(screen.getAllByText(new RegExp(`${t.xAfter}: ${t.xUnplaced}$`)).length).toBeGreaterThan(0);
  });
});

describe('the decision', () => {
  it('accepts and rejects through the plan actions route', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('patch-accept'));
    await fireEvent.press(screen.getByTestId('patch-reject'));
    expect(mockAct.mock.calls).toEqual([['accept_proposal'], ['reject_proposal']]);
  });

  it('offers nothing to accept when there is no proposal', async () => {
    mockPlan = { ...RECORDED_PLAN, proposal: null };
    await show();
    expect(screen.queryByTestId('patch-accept')).toBeNull();
    expect(screen.getByText(language().xNoPatch)).toBeTruthy();
  });
});
