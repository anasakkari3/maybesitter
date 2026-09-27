/**
 * Details' pinned actions sit *below* the scroller, never over it (UAT round 2, N8).
 *
 * The UAT drove the simulator by accessibility frame: on an unscrolled Details
 * page «ذكّرني لما أوصل / لما أطلع» reported y 716, inside the band the pinned
 * actions occupy, and a tap there opened «أسقطه بوعي»'s drop confirmation
 * (shots 191, 192). The button was not drawn there: it is below the fold,
 * clipped by the scroller's viewport, and iOS still reports a clipped view's
 * frame. Shot 193 shows the viewport ending exactly at the actions' top border.
 *
 * That holds because the actions are a flex sibling *after* the scroller, so
 * the scroller's viewport ends where they begin and no content can sit under
 * them — padding the content by the footer's height would only add a blank
 * tail. This pins that structure: an overlaid (absolute) or in-scroller
 * footer at the ordinary text size is the layout that would put content
 * under the actions.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import type { Commitment } from '../../api/schemas/common';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import { DetailsScreen } from '../DetailsScreen';

// The UAT's text size. Jest's default fontScale is 2, the stacked layout,
// where the actions are deliberately part of the scrolling content.
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 402, height: 874, scale: 3, fontScale: 1 })),
}));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 402, height: 874 }, insets: { top: 62, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'details-user', email: 'a@b.c', emailVerified: false, displayName: null, providerIds: ['password'] };
const ID = 'c-market';

const COMMITMENT = {
  id: ID, kind: 'task', title: 'أروح عالسوق', description: null, person: null, status: 'active',
  priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
  category: null, categorySource: 'inferred',
  timeSpec: { kind: 'due_by', dueAt: '2026-09-28T12:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'Asia/Amman' },
  currentAckState: 'not_seen', postponedUntil: null,
  createdAt: '2026-09-27T08:00:00.000Z', updatedAt: '2026-09-27T08:00:00.000Z',
  confirmedAt: '2026-09-27T08:00:00.000Z', completedAt: null, droppedAt: null,
} as Commitment;

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function OpenDetails() {
  const { actions } = useApp();
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    actions.openDetail(ID);
  }, [actions]);
  return null;
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data: COMMITMENT, etag: 'W/"v1"' } as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('Details at the ordinary text size (N8)', () => {
  it('the pinned actions follow the scroller as its sibling, so its viewport ends where they begin', async () => {
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <QueryClientProvider client={client}>
              <OpenDetails />
              <DetailsScreen />
            </QueryClientProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('details-place')).not.toBeNull());

    const scroll = screen.getByTestId('details-scroll');
    const actions = screen.getByTestId('details-actions');
    // Not inside the scroller: its content can never run under them.
    expect(within(scroll).queryByTestId('details-actions')).toBeNull();
    expect(within(scroll).queryByTestId('details-done')).toBeNull();
    // The place button is scrolled content, above the actions in the flow.
    expect(within(scroll).queryByTestId('details-place')).not.toBeNull();
    // Siblings in one column, the actions after the scroller…
    expect(actions.parent).toBe(scroll.parent);
    const siblings = scroll.parent!.children;
    expect(siblings.indexOf(actions)).toBeGreaterThan(siblings.indexOf(scroll));
    // …in the flow, not laid over it.
    expect((StyleSheet.flatten(actions.props.style) as { position?: string }).position).not.toBe('absolute');
  });
});
