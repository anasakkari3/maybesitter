/**
 * The home-screen widget's two device facts (UC-3.R1, #203).
 *
 * ── 1. "Show titles on the home screen widget" ───────────────────
 *
 * A device fact rather than an account one, because the thing it protects is
 * *this phone's* home screen and lock screen. Somebody may want titles on the
 * phone that never leaves their pocket and not on the tablet on the kitchen
 * counter; an account setting would force one answer on both.
 *
 * It is stored **per uid**, so a second account signing in on the same phone
 * starts at the default (off) instead of inheriting the first person's opt-in —
 * the same rule that clears the query cache on a uid change (#148).
 *
 * It is one boolean, not content. Anything unreadable is "off", which is the
 * default the issue fixes: titles are shown only after an explicit yes.
 *
 * The value is also held in memory and broadcast, so turning it off rewrites
 * the widget from the switch's own tap rather than at the next launch — #203's
 * "within one second" criterion. Memory moves first and the disk second, so a
 * slow or failing write can never delay the redaction.
 *
 * ── 2. The Android widget's snapshot ─────────────────────────────
 *
 * On Android the widget is drawn by this app's own JS, in a headless task the
 * launcher wakes (`react-native-android-widget`). That task has no React tree
 * and no query cache, so it reads the last snapshot from here. What is stored
 * is exactly what `buildSnapshot` produced — so with the default setting it
 * holds no commitment title at all — and it is deleted on sign-out.
 *
 * iOS does not use this: its snapshot goes to the App Group through
 * `@bacons/apple-targets`' `ExtensionStorage`, because the widget extension is
 * a separate process that cannot read this app's AsyncStorage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const TITLES_KEY_PREFIX = 'widget.showTitles.v1.';
export const ANDROID_WIDGET_SNAPSHOT_KEY = 'widget.androidSnapshot.v1';

const memory = new Map<string, boolean>();
const listeners = new Set<(uid: string, allowed: boolean) => void>();

export function widgetTitlesKey(uid: string): string {
  return `${TITLES_KEY_PREFIX}${uid}`;
}

/** The answer for this account on this phone. Off unless a stored `'true'` says otherwise. */
export async function loadWidgetTitlesAllowed(uid: string): Promise<boolean> {
  const known = memory.get(uid);
  if (known !== undefined) return known;
  try {
    const stored = await AsyncStorage.getItem(widgetTitlesKey(uid));
    const allowed = stored === 'true';
    // A value set while this read was in flight wins over the disk.
    if (!memory.has(uid)) memory.set(uid, allowed);
    return memory.get(uid) === true;
  } catch {
    return false;
  }
}

/**
 * Records the answer. Returns whether the phone kept it.
 *
 * Turning titles **on** that cannot be saved is undone, so the switch never
 * shows a yes that the next launch forgets. Turning them **off** stays off in
 * memory whatever the disk says: the widget is redacted now either way.
 */
export async function saveWidgetTitlesAllowed(uid: string, allowed: boolean): Promise<boolean> {
  memory.set(uid, allowed);
  listeners.forEach((listener) => listener(uid, allowed));
  try {
    if (allowed) await AsyncStorage.setItem(widgetTitlesKey(uid), 'true');
    else await AsyncStorage.removeItem(widgetTitlesKey(uid));
    return true;
  } catch {
    if (allowed) {
      memory.set(uid, false);
      listeners.forEach((listener) => listener(uid, false));
    }
    return false;
  }
}

export function subscribeWidgetTitlesAllowed(listener: (uid: string, allowed: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only. */
export function resetWidgetSettingsForTests(): void {
  memory.clear();
  listeners.clear();
}

export async function saveAndroidWidgetSnapshot(json: string | null): Promise<void> {
  try {
    if (json === null) await AsyncStorage.removeItem(ANDROID_WIDGET_SNAPSHOT_KEY);
    else await AsyncStorage.setItem(ANDROID_WIDGET_SNAPSHOT_KEY, json);
  } catch {
    // The widget keeps what it last drew until the snapshot expires and it
    // says "stale". Nothing here is worth an exception in a render effect.
  }
}

export async function loadAndroidWidgetSnapshot(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(ANDROID_WIDGET_SNAPSHOT_KEY);
  } catch {
    return null;
  }
}
