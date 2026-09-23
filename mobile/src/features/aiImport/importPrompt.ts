/**
 * The question the user carries to their assistant.
 *
 * It lives in the locale files rather than here because the user reads it, and
 * pastes it, in their own language — an assistant asked in Arabic answers in
 * Arabic, and a profile in the user's own words is what the server's extractor
 * is written for.
 *
 * It also asks the other assistant to leave out the categories this product
 * refuses: health, faith, politics, money, one-off events, and anything it is
 * unsure of. The server's validator drops those anyway, so asking up front is
 * the difference between the user never pasting a paragraph about their health
 * and us silently binning one.
 */
import type { Strings } from '../../i18n/strings';

export function buildAssistantPrompt(t: Strings): string {
  return t.aiImportPromptTemplate;
}
