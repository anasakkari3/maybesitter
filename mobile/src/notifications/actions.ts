/**
 * The three buttons on every reminder (UC-3.14, #200).
 *
 * Done · Later · Not doing it, on the soft category (#196) and the Must
 * category (#197) alike. Registered from the app with the user's language, and
 * registered again when the language changes, because the OS stores the titles
 * with the category and shows whatever it was last given.
 *
 * ── Why the options are what they are ────────────────────────────
 *
 * - **Done** does not open the app and is *not* destructive. Flutter marked it
 *   destructive, which paints finishing something red.
 * - **Later** does not open the app either: it defers by the default and the
 *   outbox carries it.
 * - **Not doing it** opens the app to a confirm sheet. Dropping cannot be undone
 *   from a lock screen, so nothing is dropped by the button itself.
 */
import type { NotificationAction } from 'expo-notifications';
import { AWARENESS_CATEGORY_ID, HARD_CATEGORY_ID } from './channels';
import { notificationsModule } from './nativeModules';

export const ACTION_DONE = 'done';
export const ACTION_LATER = 'later';
export const ACTION_DROP = 'drop';

/** The default defer for Later, and the one the button's title names. */
export const DEFAULT_DEFER_MS = 60 * 60 * 1000;

export interface ActionTitles {
  readonly notifActionDone: string;
  readonly notifActionLater: string;
  readonly notifActionDrop: string;
}

export function reminderActions(titles: ActionTitles): NotificationAction[] {
  return [
    { identifier: ACTION_DONE, buttonTitle: titles.notifActionDone, options: { opensAppToForeground: false } },
    { identifier: ACTION_LATER, buttonTitle: titles.notifActionLater, options: { opensAppToForeground: false } },
    {
      identifier: ACTION_DROP,
      buttonTitle: titles.notifActionDrop,
      options: { opensAppToForeground: true, isDestructive: true },
    },
  ];
}

export const CATEGORIES_WITH_ACTIONS = [AWARENESS_CATEGORY_ID, HARD_CATEGORY_ID] as const;

/** Never throws: a build without the module still starts. */
export async function registerReminderActions(titles: ActionTitles): Promise<void> {
  try {
    const Notifications = notificationsModule();
    if (!Notifications) return;
    const actions = reminderActions(titles);
    for (const category of CATEGORIES_WITH_ACTIONS) {
      await Notifications.setNotificationCategoryAsync(category, actions);
    }
  } catch {
    // No native module.
  }
}
