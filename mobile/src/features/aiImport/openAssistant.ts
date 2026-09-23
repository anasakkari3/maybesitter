/**
 * Opening the user's assistant, and admitting when we could not.
 *
 * ── The OS decides, not us ───────────────────────────────────────
 *
 * `Linking.openURL` with an https URL lets the system route it: a universal
 * link or Android app link hands it to the installed assistant, anything else
 * opens the browser. `canOpenURL` is what would need three competitors' schemes
 * declared in the app config, and we do not call it — we try, and we catch.
 *
 * `openBrowserAsync` is the fallback rather than the first choice because an
 * in-app SFSafariViewController / Custom Tab cannot launch a native app at all.
 * Preferring it would guarantee the browser every time, which is the outcome
 * this whole handoff exists to avoid.
 *
 * ── It returns a result, it does not throw ───────────────────────
 *
 * The same shape `openLegal` settled on. A failed handoff is not the end of the
 * flow: the user can copy the question and paste it themselves, which is what
 * the screen offers when this answers `'failed'`.
 */
import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

export type OpenOutcome = 'app_or_browser' | 'in_app_tab' | 'failed';

export async function openAssistant(url: string | null): Promise<OpenOutcome> {
  if (!url) return 'failed';

  try {
    await Linking.openURL(url);
    return 'app_or_browser';
  } catch {
    // No handler, or the OS refused. An in-app tab still shows the web app.
  }

  try {
    await WebBrowser.openBrowserAsync(url);
    return 'in_app_tab';
  } catch {
    return 'failed';
  }
}
