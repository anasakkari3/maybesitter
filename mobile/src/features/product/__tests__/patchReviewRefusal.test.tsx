/**
 * A refused plan-change offer, through the real query layer (#611).
 *
 * The server refuses `accept_proposal` / `reject_proposal` with 422 when the
 * offer on screen is not the one it holds: `stale_proposal` when the day moved
 * on (the plan changed, a meeting landed on a proposed slot, a newer offer
 * replaced it, its day ended), `no_proposal` when nothing is pending. Before
 * this, both became "check it and try again" and the stale offer stayed on
 * screen with the same two buttons, which could only be refused again.
 *
 * Only `fetch` is stubbed. The 422 goes through `apiRequest`'s status mapping,
 * `usePlanAction`'s refusal handling, the plan query's re-read and the screen,
 * so a break anywhere along that path fails here. The plan bodies are the
 * committed fixture the exporter recorded from the real GET handler; the
 * refusal body is the route's `PlanProposalRejected` branch, which the
 * exporter does not record.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { createAppQueryClient } from '../../../api/queryClient';
import { ApiProvider } from '../../../api/ui/ApiProvider';
import { strings } from '../../../i18n/strings';
import type { AuthUser } from '../../../auth/types';
import fixture from '../../../api/__fixtures__/plan.withProposal.json';
import { PatchReviewScreen } from '../ControlScreens';

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'refused-offer-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] };

type PlanBody = typeof fixture;
const ON_SCREEN: PlanBody = fixture;
const OFFER_ID = ON_SCREEN.proposal.proposalId;

/** What GET answers after a meeting landed on the offer: a newer one, for a different reason. */
const REPLACED = {
  ...fixture,
  proposal: { ...fixture.proposal, proposalId: 'prp_newer', reason: 'contains_additions' },
};
/** What GET answers once nothing is pending. */
const NOTHING_PENDING = { ...fixture, proposal: null };

let requests: { method: string; url: string; body: unknown }[] = [];
let repository: FakeAuthRepository;
let client: ReturnType<typeof createAppQueryClient>;

/** GET answers each body in turn, then keeps answering the last; POST always refuses. */
function serve(gets: readonly unknown[], refusal: { reason: string }): void {
  let served = 0;
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit) => {
    const method = init.method as string;
    requests.push({ method, url, body: init.body === undefined ? undefined : JSON.parse(init.body as string) });
    if (method === 'POST') {
      const body = { success: false, error: 'refused', reason: refusal.reason };
      return { status: 422, text: async () => JSON.stringify(body), headers: { get: () => null } };
    }
    const body = gets[Math.min(served, gets.length - 1)];
    served += 1;
    return { status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } };
  }) as never;
}

const gets = () => requests.filter(request => request.method === 'GET');
const posts = () => requests.filter(request => request.method === 'POST');

async function mount() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <ApiProvider client={client}><PatchReviewScreen /></ApiProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('patch-accept')).not.toBeNull());
}

/** The bundle the provider rendered in, found by a string only that bundle has on screen. */
function language() {
  return Object.values(strings).find(bundle => screen.queryAllByText(bundle.xPatch).length > 0)!;
}

beforeEach(() => {
  requests = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  client = createAppQueryClient();
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  onlineManager.setOnline(true);
});
afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('accepting an offer the day has moved past', () => {
  it('names the offer on screen, says why nothing happened, and shows the offer that replaced it', async () => {
    serve([ON_SCREEN, REPLACED], { reason: 'stale_proposal' });
    await mount();
    const t = language();
    expect(screen.getByText(t.xPatchWhyRemovals)).toBeTruthy();

    await fireEvent.press(screen.getByTestId('patch-accept'));

    await waitFor(() => expect(screen.getByTestId('patch-refused')).toHaveTextContent(t.errorsPlanProposalStale));
    expect(posts().map(request => request.body)).toEqual([{ action: 'accept_proposal', proposalId: OFFER_ID }]);
    // The plan was read again, and the screen now shows what the server holds.
    await waitFor(() => expect(gets()).toHaveLength(2));
    await waitFor(() => expect(screen.getByText(t.xPatchWhyAdditions)).toBeTruthy());
    expect(screen.queryByText(t.xPatchWhyRemovals)).toBeNull();
    expect(screen.queryByText(t.errorsValidation)).toBeNull();

    // Accepting now names the newer offer, not the refused one.
    expect(screen.getByTestId('patch-accept')).not.toBeDisabled();
    await fireEvent.press(screen.getByTestId('patch-accept'));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.body).toEqual({ action: 'accept_proposal', proposalId: 'prp_newer' });
  });
});

describe('an offer refused as stale that is still pending on the re-read', () => {
  it('holds Accept for that offer, and still lets the person keep their plan', async () => {
    // The server leaves a refused offer in place until the next replan tick
    // supersedes it, so the re-read can answer the very same offer.
    serve([ON_SCREEN, ON_SCREEN], { reason: 'stale_proposal' });
    await mount();
    const t = language();

    await fireEvent.press(screen.getByTestId('patch-accept'));

    await waitFor(() => expect(gets()).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('patch-accept')).toBeDisabled());
    expect(screen.getByTestId('patch-refused')).toHaveTextContent(t.errorsPlanProposalStale);
    expect(screen.getByTestId('patch-reject')).not.toBeDisabled();
    await fireEvent.press(screen.getByTestId('patch-accept'));
    expect(posts()).toHaveLength(1);
  });
});

describe('answering an offer that is no longer there', () => {
  it('says there is nothing to review, and stops offering the buttons', async () => {
    serve([ON_SCREEN, NOTHING_PENDING], { reason: 'no_proposal' });
    await mount();
    const t = language();

    await fireEvent.press(screen.getByTestId('patch-reject'));

    await waitFor(() => expect(gets()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId('patch-accept')).toBeNull());
    expect(posts().map(request => request.body)).toEqual([{ action: 'reject_proposal', proposalId: OFFER_ID }]);
    expect(screen.getByTestId('patch-refused')).toHaveTextContent(t.errorsPlanProposalGone);
    expect(screen.queryByTestId('patch-reject')).toBeNull();
    expect(screen.getByText(t.xNoPatch)).toBeTruthy();
  });
});
