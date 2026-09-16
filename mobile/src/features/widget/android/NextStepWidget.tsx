'use no memo';
/**
 * The Android home-screen widget (UC-3.R1, #203).
 *
 * Drawn by `react-native-android-widget`, which turns this JSX into
 * `RemoteViews` — so these are the library's primitives, not React Native
 * views, and hooks are not allowed (the React Compiler directive above keeps
 * the compiler from inserting any).
 *
 * ── It draws the snapshot and nothing else ───────────────────────
 *
 * No network call, no query cache, no second redaction pass. Whatever titles
 * are in the snapshot were allowed by `buildSnapshot`; whatever are not were
 * never written. This component cannot leak a title it was never given.
 *
 * ── Right to left without the platform's help ────────────────────
 *
 * `RemoteViews` lays out by the *device's* direction, and the app's language
 * can differ from the device's. So direction is applied by hand from the
 * snapshot: rows are reversed and text is aligned to the right for Arabic and
 * Hebrew. That is the whole of the RTL support, and a test pins it.
 */
import React from 'react';
import { FlexWidget, TextWidget, type ColorProp } from 'react-native-android-widget';
import { color, type ColorRoles, type Scheme } from '../../../theme/tokens';
import {
  displayStateOf,
  widgetLinks,
  type WidgetItem,
  type WidgetLabels,
  type WidgetSnapshot,
} from '../snapshot';

export const ANDROID_WIDGET_NAME = 'NextStep';

export type NextStepWidgetProps = {
  snapshot: WidgetSnapshot | null;
  now: Date;
  scheme: Scheme;
  /** Used only before the app has ever written a snapshot. */
  fallback: { labels: WidgetLabels; direction: 'rtl' | 'ltr' };
};

const c = (value: string) => value as ColorProp;

function importanceColor(item: WidgetItem, roles: ColorRoles): ColorProp {
  if (item.priority === 'must') return c(roles.must);
  if (item.priority === 'should') return c(roles.brand);
  return c(roles.textMuted);
}

/** Children in reading order, flipped for a right-to-left snapshot. */
function inReadingOrder<T>(children: T[], rtl: boolean): T[] {
  return rtl ? [...children].reverse() : children;
}

export function NextStepWidget({ snapshot, now, scheme, fallback }: NextStepWidgetProps) {
  const roles = color[scheme];
  const state = displayStateOf(snapshot, now);
  const labels = snapshot?.labels ?? fallback.labels;
  const rtl = (snapshot?.direction ?? fallback.direction) === 'rtl';
  const textAlign = rtl ? 'right' : 'left';
  const alignItems = rtl ? 'flex-end' : 'flex-start';
  const captureLink = snapshot?.links.capture ?? widgetLinks.capture;
  const todayLink = snapshot?.links.today ?? widgetLinks.today;

  const header = (
    <FlexWidget
      style={{ width: 'match_parent', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
    >
      {inReadingOrder([
        <TextWidget
          key="label"
          text={labels.nextStep}
          style={{ fontSize: 13, color: c(roles.textMuted), textAlign }}
        />,
        <TextWidget
          key="capture"
          accessibilityLabel={labels.capture}
          text={labels.capture}
          clickAction="OPEN_URI"
          clickActionData={{ uri: captureLink }}
          style={{
            fontSize: 13,
            color: c(roles.onBrand),
            backgroundColor: c(roles.brand),
            borderRadius: 14,
            paddingHorizontal: 12,
            paddingVertical: 6,
          }}
        />,
      ], rtl)}
    </FlexWidget>
  );

  let body: React.JSX.Element;
  if (state === 'populated' && snapshot) {
    body = (
      <FlexWidget style={{ width: 'match_parent', flexDirection: 'column', alignItems, flexGap: 8 }}>
        {snapshot.items.map((item, index) => (
          <FlexWidget
            key={item.id}
            clickAction="OPEN_URI"
            clickActionData={{ uri: item.link }}
            style={{ width: 'match_parent', flexDirection: 'row', alignItems: 'center', flexGap: 8 }}
          >
            {inReadingOrder([
              <FlexWidget
                key="dot"
                style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: importanceColor(item, roles) }}
              />,
              <FlexWidget key="title" style={{ flex: 1, flexDirection: 'column', alignItems }}>
                <TextWidget
                  text={item.title}
                  maxLines={1}
                  truncate="END"
                  style={{
                    fontSize: index === 0 ? 17 : 14,
                    fontWeight: index === 0 ? '600' : 'normal',
                    color: c(item.titleRedacted ? roles.textMuted : roles.textPrimary),
                    textAlign,
                  }}
                />
              </FlexWidget>,
              ...(item.timeLabel
                ? [<TextWidget key="time" text={item.timeLabel} style={{ fontSize: 13, color: c(roles.textMuted) }} />]
                : []),
            ], rtl)}
          </FlexWidget>
        ))}
      </FlexWidget>
    );
  } else if (state === 'empty') {
    body = (
      <FlexWidget
        clickAction="OPEN_URI"
        clickActionData={{ uri: captureLink }}
        style={{ width: 'match_parent', flexDirection: 'column', alignItems }}
      >
        <TextWidget text={labels.empty} style={{ fontSize: 15, color: c(roles.textPrimary), textAlign }} />
      </FlexWidget>
    );
  } else {
    // Stale, or nothing written yet. The old items are not drawn: a list that
    // may be hours out of date is worse than a line saying so.
    body = (
      <FlexWidget
        clickAction="OPEN_URI"
        clickActionData={{ uri: todayLink }}
        style={{ width: 'match_parent', flexDirection: 'column', alignItems }}
      >
        <TextWidget text={labels.stale} style={{ fontSize: 14, color: c(roles.textMuted), textAlign }} />
      </FlexWidget>
    );
  }

  return (
    <FlexWidget
      style={{
        width: 'match_parent',
        height: 'match_parent',
        flexDirection: 'column',
        justifyContent: 'flex-start',
        flexGap: 10,
        padding: 14,
        borderRadius: 22,
        backgroundColor: c(roles.surface),
      }}
    >
      {header}
      {body}
    </FlexWidget>
  );
}
