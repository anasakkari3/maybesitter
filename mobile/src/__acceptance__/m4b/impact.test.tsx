import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Root } from '../../Root';
import {
  NOW,
  capabilities,
  instant,
  prepare,
  press,
  providers,
  teardown,
  type M4bHarness,
  type RecordedRequest,
  type RouteReply,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const EVENING_ID = 'evening-item';
const IMPORTANT_ID = 'exam-item';
const PREP_ID = 'prep-item';
const ROLE_CASES: ['evening' | 'important', string][] = [
  ['evening', EVENING_ID],
  ['important', IMPORTANT_ID],
];

function impact(role: 'evening' | 'important', prep: null | { state: 'offered'; itemId: string } | { state: 'no_slot' } = null) {
  return {
    kind: 'late_before_important', role,
    otherTitle: role === 'evening' ? 'Math exam' : 'Birthday dinner',
    otherStartsAt: role === 'evening' ? instant('2030-03-30', '09:00') : instant('2030-03-29', '21:00'),
    otherEndsAt: role === 'evening' ? instant('2030-03-30', '11:00') : instant('2030-03-29', '23:30'),
    readiness: null, prep,
  };
}

function proposal(options: {
  role?: 'evening' | 'important';
  revision?: number;
  readiness?: 'ready' | 'not_ready' | 'unsure' | null;
  prep?: null | { state: 'offered'; itemId: string } | { state: 'no_slot' };
  withPrepItem?: boolean;
  includeImpact?: boolean;
} = {}) {
  const role = options.role ?? 'evening';
  const itemId = role === 'evening' ? EVENING_ID : IMPORTANT_ID;
  const baseImpact = { ...impact(role, options.prep ?? null), readiness: options.readiness ?? null };
  const items: Record<string, unknown>[] = [{
    itemId,
    title: role === 'evening' ? 'Birthday dinner' : 'Math exam',
    resolvedTime: role === 'evening' ? instant('2030-03-29', '21:00') : instant('2030-03-30', '09:00'),
    endTime: role === 'evening' ? instant('2030-03-29', '23:30') : instant('2030-03-30', '11:00'),
    needsClarification: false,
    ...(options.includeImpact === false ? {} : { impacts: [baseImpact] }),
  }];
  if (options.withPrepItem) {
    items.push({
      itemId: PREP_ID, title: 'Prepare for Math exam', resolvedTime: instant('2030-03-29', '18:00'),
      endTime: instant('2030-03-29', '19:00'), needsClarification: false,
      generated: { kind: 'evening_impact_prep', sourceItemId: itemId },
    });
  }
  return {
    version: 'v1', proposalId: 'proposal-impact', revision: options.revision ?? 7,
    status: 'proposed', items, seeds: [],
    understood: items.map(item => ({ kind: 'commitment', itemId: item.itemId, text: item.title })),
  };
}

function chatAnswer(value: ReturnType<typeof proposal>) {
  return {
    conversationId: 'conversation-impact', reply: 'Review these suggestions.', engine: 'rules', proposal: value,
    turns: [
      { role: 'user', text: 'Dinner and exam' },
      { role: 'assistant', text: 'Review these suggestions.' },
    ],
  };
}

let harness: M4bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

async function showProposal(
  value: ReturnType<typeof proposal>,
  extra?: (request: RecordedRequest) => RouteReply | Promise<RouteReply> | undefined,
  capability = true,
): Promise<void> {
  harness = await prepare('en', async request => {
    if (request.path === '/api/mobile/capabilities/m4b') {
      return { status: 200, body: capabilities({ eveningImpact: capability }) };
    }
    if (request.path === '/api/mobile/capture/chat' && request.method === 'POST') {
      return { status: 200, body: chatAnswer(value) };
    }
    return await extra?.(request);
  });
  await render(providers(harness, <Root />));
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  await press('tab-capture');
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
  await act(async () => { await fireEvent.changeText(screen.getByTestId('capture-input'), 'Dinner and exam'); });
  await press('capture-analyze');
  await waitFor(() => expect(harness!.server.matching('POST', /\/capture\/chat$/)).toHaveLength(1));
  const reveal = screen.queryByTestId('understood-confirm');
  if (reveal) await press('understood-confirm');
}

describe('R2.3 evening impact', () => {
  it.each(ROLE_CASES)('R2.3 renders the impact line on the %s role card', async (role, itemId) => {
    await showProposal(proposal({ role }));
    await waitFor(() => expect(screen.queryByTestId(`impact-line-${itemId}`)).not.toBeNull());
    expect(screen.queryByTestId(`review-card-${itemId}`)).not.toBeNull();
  });

  it('R2.3 exposes one labelled radio group with three radio choices', async () => {
    await showProposal(proposal());
    const group = await screen.findByTestId(`impact-ready-group-${EVENING_ID}`);

    expect(group.props.accessibilityRole).toBe('radiogroup');
    expect(group.props.accessibilityLabel).toEqual(expect.any(String));
    for (const answer of ['ready', 'not_ready', 'unsure']) {
      const chip = screen.getByTestId(`impact-ready-${EVENING_ID}-${answer}`);
      expect(chip.props.accessibilityRole).toBe('radio');
      expect(chip.props.accessibilityState?.checked).toBe(false);
    }
  });

  it('R2.3 readiness sends the proposal identity, revision, item and answer', async () => {
    await showProposal(
      proposal(),
      request => request.path === '/api/mobile/capture/impact' && request.method === 'POST'
        ? { status: 200, body: proposal({ revision: 8, readiness: 'ready' }) }
        : undefined,
    );
    await waitFor(() => expect(screen.queryByTestId(`impact-ready-${EVENING_ID}-ready`)).not.toBeNull());
    await press(`impact-ready-${EVENING_ID}-ready`);

    await waitFor(() => expect(harness!.server.matching('POST', /\/capture\/impact$/)).toHaveLength(1));
    expect(harness!.server.matching('POST', /\/capture\/impact$/)[0]!.body).toEqual({
      proposalId: 'proposal-impact', revision: 7, itemId: EVENING_ID, readiness: 'ready',
    });
  });

  it('R2.3 not_ready inserts an ordinary prep card and announces it once', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    await showProposal(
      proposal(),
      request => request.path === '/api/mobile/capture/impact' && request.method === 'POST'
        ? { status: 200, body: proposal({
          revision: 8, readiness: 'not_ready', prep: { state: 'offered', itemId: PREP_ID }, withPrepItem: true,
        }) }
        : undefined,
    );
    await waitFor(() => expect(screen.queryByTestId(`impact-ready-${EVENING_ID}-not_ready`)).not.toBeNull());
    announce.mockClear();
    await press(`impact-ready-${EVENING_ID}-not_ready`);

    await waitFor(() => expect(screen.queryByTestId(`review-card-${PREP_ID}`)).not.toBeNull());
    expect(screen.queryByTestId(`review-item-${PREP_ID}`)).not.toBeNull();
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('R2.3 no preparation slot renders the no-slot line on the source item', async () => {
    await showProposal(
      proposal(),
      request => request.path === '/api/mobile/capture/impact' && request.method === 'POST'
        ? { status: 200, body: proposal({ revision: 8, readiness: 'not_ready', prep: { state: 'no_slot' } }) }
        : undefined,
    );
    await waitFor(() => expect(screen.queryByTestId(`impact-ready-${EVENING_ID}-not_ready`)).not.toBeNull());
    await press(`impact-ready-${EVENING_ID}-not_ready`);

    await waitFor(() => expect(screen.queryByTestId(`impact-prep-noslot-${EVENING_ID}`)).not.toBeNull());
  });

  it('R2.3 hides the server impact after the person changes that card time locally', async () => {
    await showProposal(proposal());
    await waitFor(() => expect(screen.queryByTestId(`impact-line-${EVENING_ID}`)).not.toBeNull());
    await press(`review-edit-${EVENING_ID}`);
    await waitFor(() => expect(screen.queryByTestId('edit-item-no-time')).not.toBeNull());
    await act(async () => { await fireEvent(screen.getByTestId('edit-item-no-time'), 'valueChange', true); });
    await press('edit-item-save');

    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).toBeNull());
    expect(screen.queryByTestId(`impact-line-${EVENING_ID}`)).toBeNull();
  });

  it('R2.3 proposal_changed redraws the returned current proposal', async () => {
    const current = proposal({ revision: 9, role: 'important' });
    await showProposal(
      proposal(),
      request => request.path === '/api/mobile/capture/impact' && request.method === 'POST'
        ? { status: 409, body: { success: false, error: 'proposal_changed', proposal: current } }
        : undefined,
    );
    await waitFor(() => expect(screen.queryByTestId(`impact-ready-${EVENING_ID}-unsure`)).not.toBeNull());
    await press(`impact-ready-${EVENING_ID}-unsure`);

    await waitFor(() => expect(screen.queryByTestId(`impact-line-${IMPORTANT_ID}`)).not.toBeNull());
    expect(screen.queryByTestId(`review-card-${IMPORTANT_ID}`)).not.toBeNull();
  });

  it('M4B-REV-007 capability false hides every impact affordance and makes no impact request', async () => {
    await showProposal(proposal({ includeImpact: false }), undefined, false);
    await waitFor(() => expect(screen.queryByTestId(`review-card-${EVENING_ID}`)).not.toBeNull());

    expect(screen.queryByTestId(`impact-line-${EVENING_ID}`)).toBeNull();
    expect(screen.queryByTestId(`impact-ready-group-${EVENING_ID}`)).toBeNull();
    expect(harness!.server.matching('POST', /\/capture\/impact$/)).toHaveLength(0);
    expect(harness!.server.matching('GET', /\/capabilities\/m4b$/)).not.toHaveLength(0);
  });
});
