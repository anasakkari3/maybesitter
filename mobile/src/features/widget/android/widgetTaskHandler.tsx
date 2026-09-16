'use no memo';
/**
 * What the launcher wakes when it wants the Android widget drawn (UC-3.R1, #203).
 *
 * Registered in `index.ts` with `registerWidgetTaskHandler`. It runs as a
 * headless JS task: no React tree, no signed-in session, no query cache. So it
 * does one thing — read the last snapshot the app wrote and draw it against
 * the current time, which is how an expired snapshot becomes "stale" on the
 * 30-minute `updatePeriodMillis` tick without the app running.
 *
 * It never fetches. #203: "The widget never makes network calls."
 */
import React from 'react';
import type { WidgetTaskHandlerProps } from 'react-native-android-widget';
import { loadAndroidWidgetSnapshot } from '../../../lib/deviceSettings/widget';
import { loadLanguagePref, resolveLanguage } from '../../../i18n/language';
import { isRtl } from '../../../i18n/locale';
import { strings } from '../../../i18n/strings';
import { parseSnapshot, type WidgetLabels } from '../snapshot';
import { widgetLabelsFor } from '../labels';
import { ANDROID_WIDGET_NAME, NextStepWidget } from './NextStepWidget';

export type WidgetTaskDeps = {
  loadSnapshot: () => Promise<string | null>;
  now: () => Date;
  fallback: () => Promise<{ labels: WidgetLabels; direction: 'rtl' | 'ltr' }>;
};

async function defaultFallback() {
  const lang = resolveLanguage(await loadLanguagePref());
  return { labels: widgetLabelsFor(strings[lang]), direction: isRtl(lang) ? 'rtl' as const : 'ltr' as const };
}

export const defaultWidgetTaskDeps: WidgetTaskDeps = {
  loadSnapshot: loadAndroidWidgetSnapshot,
  now: () => new Date(),
  fallback: defaultFallback,
};

export async function renderNextStepWidget(deps: WidgetTaskDeps = defaultWidgetTaskDeps) {
  const [raw, fallback] = await Promise.all([deps.loadSnapshot(), deps.fallback()]);
  const snapshot = parseSnapshot(raw);
  const now = deps.now();
  return {
    light: <NextStepWidget snapshot={snapshot} now={now} scheme="light" fallback={fallback} />,
    dark: <NextStepWidget snapshot={snapshot} now={now} scheme="dark" fallback={fallback} />,
  };
}

export function createWidgetTaskHandler(deps: WidgetTaskDeps = defaultWidgetTaskDeps) {
  return async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
    if (props.widgetInfo.widgetName !== ANDROID_WIDGET_NAME) return;
    switch (props.widgetAction) {
      case 'WIDGET_ADDED':
      case 'WIDGET_UPDATE':
      case 'WIDGET_RESIZED':
        props.renderWidget(await renderNextStepWidget(deps));
        break;
      // Clicks are `OPEN_URI`, which the library handles natively without
      // waking this task; deletion leaves nothing of the widget's own to clean.
      default:
        break;
    }
  };
}

export const widgetTaskHandler = createWidgetTaskHandler();
