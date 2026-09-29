/**
 * Opening the user's assistant, and admitting when we could not.
 *
 * ── Installed app → the app; no app → the web chat (CL2b, #21) ──
 *
 * iOS: the app's claimed link goes through the native `universalLinksOnly`
 * check (`modules/universal-link`), which opens the installed app or nothing
 * and says which. Nothing → the web chat URL. Handing the app path to
 * `Linking.openURL` instead would reach Safari when the app is absent, and
 * for ChatGPT Safari follows a 302 to the App Store. A build without the native
 * module (an old dev client) opens the web chat: never the store.
 *
 * Android: App Links already open the installed app or the browser, so the
 * web chat URL goes straight to `Linking.openURL`.
 *
 * `canOpenURL` is what would need three competitors' schemes declared in the
 * app config, and we do not call it.
 *
 * `openBrowserAsync` is the last fallback, with the web chat URL: an in-app
 * SFSafariViewController / Custom Tab cannot launch a native app at all, so
 * it is only for when the OS refused to open anything.
 *
 * ── It returns a result, it does not throw ───────────────────────
 *
 * The same shape `openLegal` settled on. A failed handoff is not the end of the
 * flow: the user can copy the question and paste it themselves, which is what
 * the screen offers when this answers `'failed'`.
 */
import { Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { universalLinkNativeModule, type UniversalLinkNativeModule } from '../../../modules/universal-link';
import { ASSISTANTS, type ImportAssistant } from './assistants';

export type OpenOutcome = 'app' | 'app_or_browser' | 'in_app_tab' | 'failed';

export interface OpenAssistantOptions {
  /** Tests pass one; production reads `Platform.OS`. */
  platform?: string;
  /** Tests pass a fake (or null). Production reads the optional native module. */
  universalLink?: UniversalLinkNativeModule | null;
}

export async function openAssistant(
  assistant: ImportAssistant,
  options: OpenAssistantOptions = {},
): Promise<OpenOutcome> {
  const { appUrl, webUrl } = ASSISTANTS[assistant];
  if (!webUrl) return 'failed';

  if ((options.platform ?? Platform.OS) === 'ios' && appUrl) {
    const native = options.universalLink !== undefined ? options.universalLink : universalLinkNativeModule();
    try {
      if (native && (await native.openUniversalLink(appUrl))) return 'app';
    } catch {
      // The check failed: treated as "no app", so the web chat still opens.
    }
  }

  try {
    await Linking.openURL(webUrl);
    return 'app_or_browser';
  } catch {
    // No handler, or the OS refused. An in-app tab still shows the web chat.
  }

  try {
    await WebBrowser.openBrowserAsync(webUrl);
    return 'in_app_tab';
  } catch {
    return 'failed';
  }
}
