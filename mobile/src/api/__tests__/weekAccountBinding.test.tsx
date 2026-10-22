/**
 * M5B2A-R22-003: on a direct A→B account switch the week screen stays
 * mounted. Its query must never draw A's week under B while B's is composed,
 * and the request it sends is bound to B and abortable.
 */
import React from 'react';
import { Text } from 'react-native';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as plans from '../endpoints/plans';
import { useWeek } from '../queries';

let mockAuth: { user: { uid: string } | null } = { user: { uid: 'uid-a' } };
jest.mock('../../auth/AuthProvider', () => ({ useAuth: () => mockAuth }));
jest.mock('../endpoints/plans', () => {
  const actual = jest.requireActual<Record<string, unknown>>('../endpoints/plans');
  return { ...actual, proposeWeek: jest.fn(), getSavedWeek: jest.fn() };
});

const DECISIONS = { moves: [], drops: [] };
const weekOf = (title: string) => ({ days: [{ date: '2026-10-22', title }] }) as never;

function Week() {
  const query = useWeek(DECISIONS);
  const days = (query.data as { days?: { title: string }[] } | undefined)?.days ?? [];
  return <Text testID="week">{days.map((day) => day.title).join(',') || 'none'}</Text>;
}

describe('the week across an account switch (M5B2A-R22-003)', () => {
  afterEach(() => { mockAuth = { user: { uid: 'uid-a' } }; jest.clearAllMocks(); });

  it("never shows A's week under B, and asks for B's week as B", async () => {
    const proposeWeek = plans.proposeWeek as jest.MockedFunction<typeof plans.proposeWeek>;
    proposeWeek.mockResolvedValueOnce(weekOf('A private title'));
    let resolveB!: (value: never) => void;
    proposeWeek.mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve as never; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const tree = () => <QueryClientProvider client={client}><Week /></QueryClientProvider>;
    const view = await render(tree());
    await waitFor(() => expect(screen.getByTestId('week').props.children).toBe('A private title'));

    mockAuth = { user: { uid: 'uid-b' } };
    await view.rerender(tree());
    expect(screen.getByTestId('week').props.children).toBe('none');
    expect(proposeWeek).toHaveBeenLastCalledWith(DECISIONS, expect.objectContaining({ asUid: 'uid-b', signal: expect.anything() }));

    await act(async () => { resolveB(weekOf('B title')); });
    await waitFor(() => expect(screen.getByTestId('week').props.children).toBe('B title'));
  });

  it('keeps the previous week on screen while the same account changes its decisions', async () => {
    const proposeWeek = plans.proposeWeek as jest.MockedFunction<typeof plans.proposeWeek>;
    proposeWeek.mockResolvedValueOnce(weekOf('first'));
    proposeWeek.mockImplementationOnce(() => new Promise(() => undefined));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    function Moving({ moved }: { moved: boolean }) {
      const query = useWeek(moved ? { moves: [{ itemId: 'x', date: '2026-10-23' }], drops: [] } : DECISIONS);
      const days = (query.data as { days?: { title: string }[] } | undefined)?.days ?? [];
      return <Text testID="week">{days.map((day) => day.title).join(',') || 'none'}</Text>;
    }
    const view = await render(<QueryClientProvider client={client}><Moving moved={false} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId('week').props.children).toBe('first'));
    await view.rerender(<QueryClientProvider client={client}><Moving moved /></QueryClientProvider>);
    expect(screen.getByTestId('week').props.children).toBe('first');
  });
});
