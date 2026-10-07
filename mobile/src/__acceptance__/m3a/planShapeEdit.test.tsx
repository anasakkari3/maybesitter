import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor, within } from '@testing-library/react-native';
import {
  PLAN,
  PLAN_ID,
  defaultReply,
  changeText,
  lastRequest,
  openGoal,
  prepare,
  press,
  teardown,
  valueChange,
  type M3aHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M3aHarness;

beforeEach(async () => {
  harness = await prepare();
});
afterEach(async () => {
  await teardown(harness);
});

async function openDraft(): Promise<void> {
  await openGoal(harness);
  await press('goal-plan-open');
  await waitFor(() => expect(screen.queryByTestId('plan-step-step-1')).not.toBeNull());
}

describe('M3a A1 plan shape', () => {
  it('A1 plan shape: phases are ordered points and every step shows title, duration, kind and rhythm', async () => {
    await openDraft();

    const phases = screen.getAllByTestId(/^plan-phase-week-/).map((node) => node.props.testID);
    expect(phases).toEqual(['plan-phase-week-1', 'plan-phase-week-2', 'plan-phase-week-3']);
    expect(within(screen.getByTestId('plan-step-step-1')).getByText('Plan three lunches')).toBeTruthy();
    expect(screen.getByTestId('plan-step-duration-step-1')).toBeTruthy();
    expect(screen.getByTestId('plan-step-kind-step-1')).toBeTruthy();
    expect(screen.getByTestId('plan-step-rhythm-step-2')).toBeTruthy();
  });

  it('A1 disclosures: why and outcome start collapsed, and null fields have no line', async () => {
    await openDraft();

    expect(screen.getByTestId('plan-step-why-step-2').props.accessibilityState).toMatchObject({
      expanded: false,
    });
    expect(screen.getByTestId('plan-step-outcome-step-2').props.accessibilityState).toMatchObject({
      expanded: false,
    });
    expect(screen.queryByTestId('plan-step-why-step-1')).toBeNull();
    expect(screen.queryByTestId('plan-step-outcome-step-3')).toBeNull();
  });
});

describe('M3a A2 whole-plan editing', () => {
  it('A2 whole-plan edit: reorder sends one op with the viewed revision and planId in the path', async () => {
    await openDraft();
    await press('plan-edit');
    await press('plan-move-up-step-2');

    await waitFor(() =>
      expect(harness.server.matching('PATCH', new RegExp(`/plans/${PLAN_ID}$`))).toHaveLength(1),
    );
    const request = lastRequest(harness.server, 'PATCH', new RegExp(`/plans/${PLAN_ID}$`));
    expect(request.body).toEqual(
      expect.objectContaining({
        revision: PLAN.revision,
        op: expect.objectContaining({ op: 'reorder', stepId: 'step-2', toOrder: 1 }),
      }),
    );
  });

  it('A2 whole-plan edit: remove exposes restore and each tap is one versioned op', async () => {
    await openDraft();
    await press('plan-edit');
    await press('plan-remove-step-2');
    await waitFor(() =>
      expect(harness.server.matching('PATCH', new RegExp(`/plans/${PLAN_ID}$`))).toHaveLength(1),
    );
    expect(lastRequest(harness.server, 'PATCH', new RegExp(`/plans/${PLAN_ID}$`)).body).toEqual(
      expect.objectContaining({
        revision: PLAN.revision,
        op: expect.objectContaining({ op: 'remove', stepId: 'step-2' }),
      }),
    );

    await press('plan-restore-step-2');
    await waitFor(() =>
      expect(harness.server.matching('PATCH', new RegExp(`/plans/${PLAN_ID}$`))).toHaveLength(2),
    );
    expect(lastRequest(harness.server, 'PATCH', new RegExp(`/plans/${PLAN_ID}$`)).body).toEqual(
      expect.objectContaining({
        revision: PLAN.revision + 1,
        op: expect.objectContaining({ op: 'restore', stepId: 'step-2' }),
      }),
    );
  });

  it('A2 whole-plan edit: add sends one bounded add op with phase, duration and kind', async () => {
    await openDraft();
    await press('plan-edit');
    await press('plan-add-step');
    await changeText('plan-add-title', 'Pack lunch');
    await valueChange('plan-add-kind', 'commitment');
    await valueChange('plan-add-duration', 20);
    await valueChange('plan-add-phase', { unit: 'week', index: 2 });
    await press('plan-add-save');

    await waitFor(() =>
      expect(harness.server.matching('PATCH', new RegExp(`/plans/${PLAN_ID}$`))).toHaveLength(1),
    );
    expect(lastRequest(harness.server, 'PATCH', new RegExp(`/plans/${PLAN_ID}$`)).body).toEqual(
      expect.objectContaining({
        revision: PLAN.revision,
        op: expect.objectContaining({
          op: 'add',
          afterStepId: null,
          step: {
            title: 'Pack lunch',
            kind: 'commitment',
            durationMinutes: 20,
            phase: { unit: 'week', index: 2 },
          },
        }),
      }),
    );
  });

  it('A2 whole-plan edit: update words, kind, rhythm, duration and phase are one atomic op', async () => {
    await openDraft();
    await press('plan-edit');
    await changeText('plan-edit-title-step-1', 'Prepare lunches');
    await valueChange('plan-edit-kind-step-1', 'habit');
    await valueChange('plan-edit-rhythm-step-1', { timesPerWeek: 4, timeOfDay: 'morning' });
    await valueChange('plan-edit-duration-step-1', 25);
    await valueChange('plan-edit-phase-step-1', { unit: 'week', index: 2 });
    await press('plan-edit-save-step-1');

    await waitFor(() =>
      expect(harness.server.matching('PATCH', new RegExp(`/plans/${PLAN_ID}$`))).toHaveLength(1),
    );
    expect(lastRequest(harness.server, 'PATCH', new RegExp(`/plans/${PLAN_ID}$`)).body).toEqual(
      expect.objectContaining({
        revision: PLAN.revision,
        op: {
          op: 'update',
          stepId: 'step-1',
          fields: {
            title: 'Prepare lunches',
            kind: 'habit',
            durationMinutes: 25,
            rhythm: { timesPerWeek: 4, timeOfDay: 'morning' },
            phase: { unit: 'week', index: 2 },
          },
        },
      }),
    );
  });

  it('A2 stale: a 409 adopts the returned plan and never resubmits', async () => {
    const current = {
      ...PLAN,
      revision: 11,
      steps: PLAN.steps.map((step) =>
        step.stepId === 'step-1' ? { ...step, title: 'Current server title' } : step,
      ),
    };
    harness.server.handler = (request) =>
      request.method === 'PATCH'
        ? {
            status: 409,
            body: { success: false, error: 'stale', reason: 'stale', plan: current },
          }
        : defaultReply(request);
    await openDraft();
    await press('plan-edit');
    await press('plan-move-down-step-1');

    await waitFor(() => expect(screen.queryByText('Current server title')).not.toBeNull());
    expect(harness.server.matching('PATCH', new RegExp(`/plans/${PLAN_ID}$`))).toHaveLength(1);
  });

  it('A2 too_many_edits: 422 shows its own failure and recovery action', async () => {
    harness.server.handler = (request) =>
      request.method === 'PATCH'
        ? {
            status: 422,
            body: {
              success: false,
              error: 'too_many_edits',
              reason: 'too_many_edits',
              plan: PLAN,
            },
          }
        : defaultReply(request);
    await openDraft();
    await press('plan-edit');
    await press('plan-move-down-step-1');

    await waitFor(() => expect(screen.queryByTestId('plan-failure')).not.toBeNull());
    expect(screen.getByTestId('plan-failure').props.children).not.toContain(
      'Something went wrong on our side.',
    );
    expect(screen.getByTestId('plan-failure-action')).toBeTruthy();
  });

  it('A2 approval: one whole-plan approval sends revision and no card has an approval control', async () => {
    await openDraft();
    expect(screen.queryAllByTestId(/^plan-step-approve-/)).toHaveLength(0);
    await press('plan-approve');

    await waitFor(() => expect(harness.server.matching('POST', /\/approve$/)).toHaveLength(1));
    expect(lastRequest(harness.server, 'POST', /\/approve$/).body).toEqual({ revision: PLAN.revision });
  });
});
