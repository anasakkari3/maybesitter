import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, renderHook } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import * as endpoints from '../../../api/endpoints/capture';
import * as consents from '../../../api/endpoints/consents';
import { NetworkError } from '../../../api/errors';
import type { CaptureChatAnswer, CaptureConfirmation, CaptureProposal } from '../../../api/schemas/capture';
import { CaptureProvider, useCaptureFlow } from '../CaptureProvider';
import { MAX_CAPTURE_LENGTH } from '../captureMachine';

const user = { uid: 'draft-provider-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] };
let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function proposal(id = 'p1'): CaptureProposal {
  return {
    version: 'v1', proposalId: id, status: 'proposed', seeds: [],
    items: [{ itemId: 'i1', title: 'Call the clinic', resolvedTime: null, needsClarification: false }],
  };
}

/** The chat's answer carrying `p`, for one message in a new conversation. */
function answer(p: CaptureProposal, message = 'x'): CaptureChatAnswer {
  return {
    conversationId: '00000000-0000-4000-8000-000000000001', reply: 'Check it and confirm.', engine: 'rules', proposal: p,
    turns: [{ role: 'user', text: message }, { role: 'assistant', text: 'Check it and confirm.' }],
  };
}

function pendingResult<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider repository={repository} isDevBundle={false}>
    <QueryClientProvider client={client}><CaptureProvider>{children}</CaptureProvider></QueryClientProvider>
  </AuthProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  repository = createFakeAuthRepository({ initialUser: user });
  jest.spyOn(consents, 'getConsents').mockResolvedValue({
    aiProcessing: { state: 'declined', asked: true },
    recommendations: { state: 'declined', asked: true },
    currentVersions: { aiProcessing: 'v1', recommendations: 'v1' },
  } as never);
});

afterEach(async () => {
  await cleanup();
  client.clear();
  jest.restoreAllMocks();
});

it('sends the explicit approved draft even when setText has not rendered yet', async () => {
  const propose = jest.spyOn(endpoints, 'chatCapture').mockImplementation(async ({ message }) => answer(proposal(), message));
  const confirm = jest.spyOn(endpoints, 'confirmCapture');
  const { result } = await renderHook(useCaptureFlow, { wrapper });
  await act(() => result.current.setText('the previous capture'));
  const approved = '  Call the clinic tomorrow at 9am  ';
  await act(async () => {
    result.current.setText(approved);
    await result.current.analyze(approved);
  });
  expect(propose).toHaveBeenCalledTimes(1);
  // The first message starts a conversation: no id is sent.
  expect(propose).toHaveBeenCalledWith(expect.objectContaining({ message: approved, conversationId: null }));
  // The message moved into the conversation; the field is for the next one.
  expect(result.current.state.turns[0]).toEqual({ role: 'user', text: approved });
  expect(result.current.state.text).toBe('');
  expect(result.current.state.status).toBe('needsConfirmation');
  expect(result.current.state.persisted).toEqual([]);
  expect(confirm).not.toHaveBeenCalled();
});

it('keeps the original no-argument analyze and retries the submitted draft after failure', async () => {
  const propose = jest.spyOn(endpoints, 'chatCapture')
    .mockRejectedValueOnce(new NetworkError('offline'))
    .mockResolvedValueOnce(answer(proposal()));
  const { result } = await renderHook(useCaptureFlow, { wrapper });
  await act(() => result.current.setText('an older draft'));
  const approved = 'Call Dana tomorrow at 3pm';
  await act(() => result.current.analyze(approved));
  expect(result.current.state.status).toBe('networkError');
  expect(result.current.state.text).toBe(approved);
  await act(() => result.current.analyze());
  expect(propose.mock.calls.map(([input]) => input.message)).toEqual([approved, approved]);
  expect(result.current.state.status).toBe('needsConfirmation');
});

it('ignores repeated Send presses and a closed capture response cannot replace a new capture', async () => {
  const first = pendingResult<CaptureChatAnswer>();
  const next = pendingResult<CaptureChatAnswer>();
  const propose = jest.spyOn(endpoints, 'chatCapture')
    .mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
  const { result } = await renderHook(useCaptureFlow, { wrapper });
  let firstRun!: Promise<void>;
  let nextRun!: Promise<void>;
  await act(async () => {
    firstRun = result.current.analyze('Call Dana tomorrow');
    await result.current.analyze('Duplicate send');
  });
  expect(propose).toHaveBeenCalledTimes(1);
  await act(() => { result.current.close(); result.current.open(); });
  await act(() => { nextRun = result.current.analyze('Call Sami tomorrow'); });
  await act(async () => { first.resolve(answer(proposal('closed'))); await firstRun; });
  expect(result.current.state.text).toBe('Call Sami tomorrow');
  expect(result.current.state.status).toBe('analyzing');
  expect(result.current.state.proposal).toBeNull();
  await act(async () => { next.resolve(answer(proposal('current'))); await nextRun; });
  expect(result.current.state.proposal?.proposalId).toBe('current');
  expect(propose.mock.calls.map(([input]) => input.message)).toEqual(['Call Dana tomorrow', 'Call Sami tomorrow']);
});

it('empty and oversized replacement drafts leave the current proposal and edits intact', async () => {
  const propose = jest.spyOn(endpoints, 'chatCapture');
  const { result } = await renderHook(useCaptureFlow, { wrapper });
  await act(() => {
    result.current.adoptProposal(proposal());
    result.current.editItem('i1', { priority: 'high' });
  });
  const current = result.current.state;
  await act(() => result.current.analyze('   '));
  await act(() => result.current.analyze('x'.repeat(MAX_CAPTURE_LENGTH + 1)));
  expect(propose).not.toHaveBeenCalled();
  expect(result.current.state).toEqual(current);
  expect(result.current.state.edits.i1?.priority).toBe('high');
});

it('preserves the proposal, edits and unsent next message across a temporary screen detour', async () => {
  const propose = jest.spyOn(endpoints, 'chatCapture');
  const confirm = jest.spyOn(endpoints, 'confirmCapture');
  let flow!: ReturnType<typeof useCaptureFlow>;
  function CaptureScreenProbe() {
    const current = useCaptureFlow();
    React.useEffect(() => { flow = current; }, [current]);
    return null;
  }
  const view = await render(<CaptureScreenProbe />, { wrapper });
  await act(() => {
    flow.adoptProposal(proposal(), 'tab');
    flow.editItem('i1', { priority: 'high' });
    // Typed under the proposal: the next message of the conversation.
    flow.setText('Add a 20 minute commute before the appointment');
  });
  const review = flow.state;
  // Root temporarily replaces CaptureFlow with Trust, leaving CaptureProvider
  // mounted. Returning mounts a fresh screen under that same provider.
  await view.rerender(<></>);
  await view.rerender(<CaptureScreenProbe />);
  expect(flow.state).toEqual(review);
  // Typing under a proposal changes nothing about it.
  expect(flow.state.status).toBe('needsConfirmation');
  expect(flow.state.text).toBe('Add a 20 minute commute before the appointment');
  expect(propose).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  await act(() => flow.close());
  expect(flow.state.proposal).toBeNull();
  expect(flow.state.text).toBe('');
});

it.each(['open', 'close', 'adoptProposal', 'startOver'] as const)('%s clears the former unsent message', async transition => {
  const { result } = await renderHook(useCaptureFlow, { wrapper });
  await act(() => {
    result.current.adoptProposal(proposal(), 'tab');
    result.current.setText('An unsent private continuation');
  });
  await act(() => {
    if (transition === 'adoptProposal') result.current.adoptProposal(proposal('next'));
    else result.current[transition]();
  });
  expect(result.current.state.text).toBe('');
});

it('back from a chat proposal puts what the person said in the field, not the unsent message, and ends the conversation', async () => {
  jest.spyOn(endpoints, 'chatCapture').mockImplementation(async ({ message }) => answer(proposal(), message));
  const { result } = await renderHook(useCaptureFlow, { wrapper });
  await act(() => result.current.analyze('Call the clinic tomorrow'));
  await act(() => result.current.setText('an unsent follow-up'));
  await act(() => result.current.backToComposer());
  expect(result.current.state.text).toBe('Call the clinic tomorrow');
  expect(result.current.state.status).toBe('editing');
  expect(result.current.state.proposal).toBeNull();
  expect(result.current.state.conversationId).toBeNull();
  expect(result.current.state.turns).toEqual([]);
});

it('a previous clarification cannot rewrite a reopened review of the same proposal', async () => {
  const pending = pendingResult<CaptureProposal>();
  jest.spyOn(endpoints, 'clarifyCapture').mockReturnValue(pending.promise);
  const asking = proposal();
  asking.status = 'needs_clarification';
  asking.items[0] = {
    ...asking.items[0]!, needsClarification: true,
    clarification: { questionId: 'q1', field: 'time', questionKey: 'ask_time', params: {}, options: [], allowFreeText: true },
  };
  const { result } = await renderHook(useCaptureFlow, { wrapper });
  await act(() => result.current.adoptProposal(asking));
  let answering!: ReturnType<typeof result.current.clarify>;
  await act(() => { answering = result.current.clarify('i1', { freeText: 'Tomorrow at 5pm' }); });
  await act(() => {
    result.current.close();
    result.current.adoptProposal(asking);
    result.current.editItem('i1', { title: 'Changed in the reopened review', priority: 'high' });
  });
  const reopened = result.current.state;
  await act(async () => { pending.resolve(proposal()); await answering; });
  expect(await answering).toMatchObject({ ok: false });
  expect(result.current.state).toEqual(reopened);
});

it.each(['success', 'failure'] as const)('a late confirmation %s cannot replace a new draft', async outcome => {
  const pending = pendingResult<CaptureConfirmation>();
  jest.spyOn(endpoints, 'confirmCapture').mockReturnValue(pending.promise);
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  const { result } = await renderHook(useCaptureFlow, { wrapper });
  await act(() => result.current.adoptProposal(proposal('original')));
  let saving!: Promise<void>;
  await act(() => { saving = result.current.confirm(); });
  await act(() => {
    result.current.close();
    result.current.open();
    result.current.setText('My next unsent capture');
  });
  await act(async () => {
    if (outcome === 'success') {
      pending.resolve({ success: true, replayed: false, persisted: [{ itemId: 'i1', commitmentId: 'c1', title: 'Call the clinic', resolvedTime: null }], failed: [] });
    } else pending.reject(new NetworkError('offline'));
    await saving;
  });
  expect(result.current.state.text).toBe('My next unsent capture');
  expect(result.current.state.status).toBe('editing');
  expect(result.current.state.persisted).toEqual([]);
  expect(result.current.state.undoable).toBe(false);
  if (outcome === 'success') {
    expect(invalidate).toHaveBeenCalledWith({ predicate: expect.any(Function) });
  }
});
