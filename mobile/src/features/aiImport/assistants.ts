/**
 * The assistants a user can bring context from, and where to send them.
 *
 * ── https, opened with the OS, and no scheme detection ───────────
 *
 * `Linking.openURL` with an https URL lets the operating system decide: a
 * universal link or Android app link hands it to the installed assistant, and
 * anything else opens the browser. That is the whole handoff. The alternative —
 * `canOpenURL` against `chatgpt://` and friends — needs three competitors'
 * schemes declared in `LSApplicationQueriesSchemes` and an Android `<queries>`
 * block, which is a store-review change that buys nothing the OS is not already
 * doing.
 *
 * ── Each URL is one the vendor's app claims ───────────────────────
 *
 * A universal link reaches the installed app only if the path is listed in the
 * vendor's apple-app-site-association file; anything else opens Safari. Checked
 * against those files on 2026-09-25:
 *   - claude.ai claims `/new` — kept.
 *   - chatgpt.com does NOT claim `/`, but claims `/app` — so `/app`, not `/`.
 *   - gemini.google.com claims only its download paths; `/app` is kept and
 *     opens the web app, which is the best on offer.
 * Re-check these files before changing a URL; the in-app browser fallback in
 * `openAssistant.ts` can never open an app, so a wrong path here means the web.
 *
 * `other` has no URL on purpose. Somebody using an assistant we have not named
 * can still copy the question and paste the answer back, which is the part of
 * this flow that actually carries the value.
 */
import type { Strings } from '../../i18n/strings';

export type ImportAssistant = 'chatgpt' | 'gemini' | 'claude' | 'other';

export const IMPORT_ASSISTANTS: readonly ImportAssistant[] = ['chatgpt', 'gemini', 'claude', 'other'];

export interface AssistantDescriptor {
  /** Opened with the OS. `null` means there is nothing to open. */
  readonly url: string | null;
  readonly labelKey: keyof Strings;
}

export const ASSISTANTS: Record<ImportAssistant, AssistantDescriptor> = {
  chatgpt: { url: 'https://chatgpt.com/app', labelKey: 'aiImportAssistantChatgpt' },
  gemini: { url: 'https://gemini.google.com/app', labelKey: 'aiImportAssistantGemini' },
  claude: { url: 'https://claude.ai/new', labelKey: 'aiImportAssistantClaude' },
  other: { url: null, labelKey: 'aiImportAssistantOther' },
};
