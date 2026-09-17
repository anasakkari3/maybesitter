/**
 * The guided setup's offline copy (UC-3.17, #469).
 *
 * Mirrors `routineCache.ts`: one copy per account, never per device (#148 —
 * four accounts on one phone once shared a survey), every storage call
 * wrapped so a device that cannot remember still gets a working screen.
 *
 * What it holds is the five draft answers and the question the user was on,
 * so backgrounding the app mid-chat does not start it over. It is a draft and
 * nothing more: the answers reach the account only through the review step,
 * and the flow clears this copy once the user finishes or skips.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  EMPTY_SETUP_ANSWERS,
  SETUP_QUESTIONS,
  type SetupAnswers,
} from '../../features/onboarding/setupChat';

/**
 * 2 since the first question became the life narrative (`life`, was `work`).
 * A version-1 draft reads as absent rather than restoring a work answer into a
 * question that no longer asks it.
 */
export const SETUP_CACHE_VERSION = 2;

export interface SetupChatCache {
  version: number;
  answers: SetupAnswers;
  /** The question the user was on, an index into `SETUP_QUESTIONS`. */
  index: number;
  /** ISO instant of the last local write. */
  updatedAt: string;
}

/** Where one account's draft lives on this device. */
export function setupChatStorageKey(accountId: string): string {
  return `onboarding.setupChat.v1.${accountId}`;
}

/**
 * A stored blob, if it is one this version understands.
 *
 * A blob from another version, or one whose index points past the questions,
 * reads as absent rather than as a partial chat: restoring it would render a
 * question that does not exist or chips the user never tapped.
 */
function parseSetupChatCache(raw: string | null): SetupChatCache | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cache = value as Record<string, unknown>;
  if (cache.version !== SETUP_CACHE_VERSION) return null;
  const answers = cache.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const index = cache.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= SETUP_QUESTIONS.length) {
    return null;
  }

  const restored: SetupAnswers = { ...EMPTY_SETUP_ANSWERS };
  for (const question of SETUP_QUESTIONS) {
    const stored = (answers as Record<string, unknown>)[question.id];
    restored[question.id] = typeof stored === 'string' ? stored : '';
  }

  return {
    version: SETUP_CACHE_VERSION,
    answers: restored,
    index,
    updatedAt: typeof cache.updatedAt === 'string' ? cache.updatedAt : '',
  };
}

/** Null when absent, corrupt, from another version, or unreadable. */
export async function loadSetupChatCache(accountId: string): Promise<SetupChatCache | null> {
  try {
    return parseSetupChatCache(await AsyncStorage.getItem(setupChatStorageKey(accountId)));
  } catch {
    return null;
  }
}

export async function saveSetupChatCache(accountId: string, cache: SetupChatCache): Promise<void> {
  try {
    await AsyncStorage.setItem(setupChatStorageKey(accountId), JSON.stringify(cache));
  } catch {
    // A draft that did not land is lost on the next launch and nothing else;
    // the screen keeps its in-memory copy for this session.
  }
}

export async function clearSetupChatCache(accountId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(setupChatStorageKey(accountId));
  } catch {
    // The user is finishing or signing out; an unremovable draft is not a
    // reason to stop them.
  }
}
