/**
 * Picking an assistant explains first, and only the button hands off.
 *
 * On the first iPhone run, tapping ChatGPT copied the question and switched
 * apps in the same instant, so the instructions for what to do there were only
 * ever seen after coming back. The literal repro: pick an assistant — nothing
 * may be written to the clipboard and nothing may be opened until the person
 * has seen the three steps and pressed the one button.
 */
import React from 'react';
import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { setStringAsync } from 'expo-clipboard';
import { AppProvider } from '../../../state/AppContext';
import { strings, fill } from '../../../i18n/strings';
import { AiImportFlow } from '../AiImportFlow';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true), getStringAsync: jest.fn(async () => '') }));
jest.mock('../../../api/queries', () => ({
  useImportAiContext: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useConfirmAiContextImport: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));

const clipboard = setStringAsync as unknown as jest.Mock;
const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const wrap = (child: React.ReactNode) => (
  <SafeAreaProvider initialMetrics={metrics}><AppProvider>{child}</AppProvider></SafeAreaProvider>
);
/** Whichever language AppProvider started in; the assertions are about order, not wording. */
const copy = () => Object.values(strings).find(t => screen.queryAllByText(t.aiImportPickTitle).length > 0)!;

let openURL: jest.SpiedFunction<typeof Linking.openURL>;
let openBrowser: jest.SpiedFunction<typeof WebBrowser.openBrowserAsync>;
const order: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  clipboard.mockImplementation(async () => { order.push('copy'); return true; });
  openURL = jest.spyOn(Linking, 'openURL').mockImplementation(async (url: string) => { order.push(`open ${url}`); return true; });
  openBrowser = jest.spyOn(WebBrowser, 'openBrowserAsync').mockResolvedValue({ type: 'dismiss' } as never);
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); clipboard.mockReset(); });

it('picking ChatGPT shows the three steps and does not copy or open anything yet', async () => {
  await render(wrap(<AiImportFlow onDone={() => undefined} onCancel={() => undefined} />));
  const t = copy();
  await fireEvent.press(screen.getByTestId('ai-import-pick-chatgpt'));

  expect(screen.getByTestId('ai-import-steps')).toBeTruthy();
  expect(screen.getByText(fill(t.aiImportStep2, { assistant: t.aiImportAssistantChatgpt }))).toBeTruthy();
  expect(screen.getByText(fill(t.aiImportCopyAndOpen, { assistant: t.aiImportAssistantChatgpt }))).toBeTruthy();
  expect(clipboard).not.toHaveBeenCalled();
  expect(openURL).not.toHaveBeenCalled();
  expect(openBrowser).not.toHaveBeenCalled();
});

it('the button copies first, then opens the ChatGPT app link, and returning shows the paste step', async () => {
  await render(wrap(<AiImportFlow onDone={() => undefined} onCancel={() => undefined} />));
  await fireEvent.press(screen.getByTestId('ai-import-pick-chatgpt'));
  await fireEvent.press(screen.getByTestId('ai-import-go'));

  await waitFor(() => expect(openURL).toHaveBeenCalledTimes(1));
  expect(order).toEqual(['copy', 'open https://chatgpt.com/app']);
  // A claimed universal link goes to the installed app; the in-app browser
  // could never open it, so it is not tried when the OS accepted the link.
  expect(openBrowser).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByTestId('ai-import-paste')).toBeTruthy());
});

it('falls back to the in-app browser only when the OS refuses the link', async () => {
  openURL.mockRejectedValueOnce(new Error('no handler'));
  await render(wrap(<AiImportFlow onDone={() => undefined} onCancel={() => undefined} />));
  await fireEvent.press(screen.getByTestId('ai-import-pick-claude'));
  await fireEvent.press(screen.getByTestId('ai-import-go'));
  await waitFor(() => expect(openBrowser).toHaveBeenCalledWith('https://claude.ai/new'));
  expect(openURL).toHaveBeenCalledWith('https://claude.ai/new');
});

it('when nothing can be opened, the question is on screen to copy by hand', async () => {
  openURL.mockRejectedValueOnce(new Error('no handler'));
  openBrowser.mockRejectedValueOnce(new Error('no browser'));
  await render(wrap(<AiImportFlow onDone={() => undefined} onCancel={() => undefined} />));
  await fireEvent.press(screen.getByTestId('ai-import-pick-gemini'));
  await fireEvent.press(screen.getByTestId('ai-import-go'));
  await waitFor(() => expect(screen.getByTestId('ai-import-open-failed')).toBeTruthy());
  expect(screen.getByTestId('ai-import-prompt-text')).toBeTruthy();
  expect(screen.getByTestId('ai-import-ready')).toBeTruthy();
});

it('another assistant: the button only copies, and goes straight to paste', async () => {
  await render(wrap(<AiImportFlow onDone={() => undefined} onCancel={() => undefined} />));
  const t = copy();
  await fireEvent.press(screen.getByTestId('ai-import-pick-other'));
  expect(screen.getByText(t.aiImportCopyOnly)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('ai-import-go'));
  await waitFor(() => expect(screen.getByTestId('ai-import-paste')).toBeTruthy());
  expect(order).toEqual(['copy']);
  expect(openURL).not.toHaveBeenCalled();
});
