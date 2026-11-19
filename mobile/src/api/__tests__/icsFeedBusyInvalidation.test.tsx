/**
 * CA10.11 (QA audit de7fcb8, confirmed on device): removing or refreshing a
 * subscribed calendar left its old lectures in «الخطة»'s free time until a
 * pull-to-refresh (83 s seen). The feed mutations reread the feed list, held
 * items and commitments, but not the server busy time the plan reads.
 */
import React from 'react';
import { Pressable } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as icsEndpoints from '../endpoints/icsFeeds';
import { useCreateIcsFeed, useDeleteIcsFeed, useRefreshIcsFeed } from '../queries';
import { ACCOUNT_A, NOW, Providers, initialState, prepare, teardown, type M5bHarness } from '../../__acceptance__/m5b/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M5bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

function Writers() {
  const create = useCreateIcsFeed();
  const refresh = useRefreshIcsFeed();
  const remove = useDeleteIcsFeed();
  return <>
    <Pressable testID="create" onPress={() => create.mutate({ url: 'https://example.test/a.ics', label: null, autoAcceptDeadlines: false })} />
    <Pressable testID="refresh" onPress={() => refresh.mutate('feed-1')} />
    <Pressable testID="remove" onPress={() => remove.mutate('feed-1')} />
  </>;
}

const SERVER_BUSY = ['user', ACCOUNT_A.uid, 'calendar', 'serverBusy'];

describe('CA10.11: a feed change rereads the plan\'s server busy time', () => {
  it.each<['remove' | 'refresh' | 'create', 'deleteIcsFeed' | 'refreshIcsFeed' | 'createIcsFeed']>([
    ['remove', 'deleteIcsFeed'],
    ['refresh', 'refreshIcsFeed'],
    ['create', 'createIcsFeed'],
  ])('%s invalidates the serverBusy queries', async (testID, endpoint) => {
    const call = jest.spyOn(icsEndpoints, endpoint).mockResolvedValue({ success: true } as never);
    harness = await prepare('en', initialState());
    await render(<Providers harness={harness}><Writers /></Providers>);
    const invalidate = jest.spyOn(harness.client, 'invalidateQueries');
    await fireEvent.press(screen.getByTestId(testID));
    await waitFor(() => expect(call.mock.calls.length).toBe(1));
    await waitFor(() => expect(harness!.client.isMutating()).toBe(0));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: SERVER_BUSY });
  });
});
