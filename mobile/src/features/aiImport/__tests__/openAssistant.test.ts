/**
 * Installed app → the app; not installed → the web chat (closure CL2b, #21).
 *
 * `https://chatgpt.com/app` is the path the ChatGPT app claims, so with the
 * app installed iOS hands it over. Without the app, Safari loads it and the
 * server answers 302 → apps.apple.com (checked with curl, 2026-09-26): the
 * user who wanted to paste a question landed in the App Store. So on iOS the
 * app path is only ever tried through the native `universalLinksOnly` check,
 * which opens nothing when no app claims the link, and the web chat is opened
 * otherwise. Android App Links already choose between the app and the browser,
 * so Android opens the web chat URL directly.
 */
import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { openAssistant } from '../openAssistant';
import type { ImportAssistant } from '../assistants';
import type { UniversalLinkNativeModule } from '../../../../modules/universal-link';

let openURL: jest.SpiedFunction<typeof Linking.openURL>;
let openBrowser: jest.SpiedFunction<typeof WebBrowser.openBrowserAsync>;

beforeEach(() => {
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
  openBrowser = jest.spyOn(WebBrowser, 'openBrowserAsync').mockResolvedValue({ type: 'dismiss' } as never);
  // `Linking.openURL` is already a jest.fn in the RN preset, so spyOn hands
  // back that same function and its calls survive `restoreAllMocks`.
  openURL.mockClear();
  openBrowser.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

function native(opened: boolean | Error) {
  const openUniversalLink = jest.fn(async (_url: string) => {
    if (opened instanceof Error) throw opened;
    return opened;
  });
  return { module: { openUniversalLink } as UniversalLinkNativeModule, openUniversalLink };
}

describe('iOS', () => {
  it('opens the installed app through the claimed link, and nothing else', async () => {
    const { module, openUniversalLink } = native(true);
    const outcome = await openAssistant('chatgpt', { platform: 'ios', universalLink: module });
    expect(openUniversalLink).toHaveBeenCalledWith('https://chatgpt.com/app');
    expect(outcome).toBe('app');
    expect(openURL).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  const cases: [ImportAssistant, string, string][] = [
    ['chatgpt', 'https://chatgpt.com/app', 'https://chatgpt.com/'],
    ['claude', 'https://claude.ai/new', 'https://claude.ai/new'],
    ['gemini', 'https://gemini.google.com/app', 'https://gemini.google.com/app'],
  ];
  it.each(cases)('no %s app: opens the web chat, never the store-redirecting app path', async (assistant, appUrl, webUrl) => {
    const { module, openUniversalLink } = native(false);
    const outcome = await openAssistant(assistant, { platform: 'ios', universalLink: module });
    expect(openUniversalLink).toHaveBeenCalledWith(appUrl);
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith(webUrl);
    expect(outcome).toBe('app_or_browser');
  });

  it('treats a failing native check as "no app"', async () => {
    const { module } = native(new Error('boom'));
    await openAssistant('chatgpt', { platform: 'ios', universalLink: module });
    expect(openURL).toHaveBeenCalledWith('https://chatgpt.com/');
  });

  it('without the native module (an old build) opens the web chat, not the app path', async () => {
    await openAssistant('chatgpt', { platform: 'ios', universalLink: null });
    expect(openURL).toHaveBeenCalledWith('https://chatgpt.com/');
    expect(openURL).not.toHaveBeenCalledWith('https://chatgpt.com/app');
  });

  it('falls back to the in-app tab with the web chat when the OS refuses it', async () => {
    const { module } = native(false);
    openURL.mockRejectedValueOnce(new Error('no handler'));
    const outcome = await openAssistant('chatgpt', { platform: 'ios', universalLink: module });
    expect(openBrowser).toHaveBeenCalledWith('https://chatgpt.com/');
    expect(outcome).toBe('in_app_tab');
  });
});

describe('Android', () => {
  it('opens the web chat URL directly: the App Link picks the app or the browser', async () => {
    const { module, openUniversalLink } = native(true);
    const outcome = await openAssistant('chatgpt', { platform: 'android', universalLink: module });
    expect(openUniversalLink).not.toHaveBeenCalled();
    expect(openURL).toHaveBeenCalledWith('https://chatgpt.com/');
    expect(outcome).toBe('app_or_browser');
  });
});

it('another assistant has nothing to open', async () => {
  expect(await openAssistant('other', { platform: 'ios', universalLink: null })).toBe('failed');
  expect(openURL).not.toHaveBeenCalled();
});
