/**
 * The Android widget's drawing (UC-3.R1, #203).
 *
 * The launcher is not reachable from Jest, but the tree this component hands
 * the library is: it is passed through the library's own `buildWidgetTree`,
 * which is exactly what `requestWidgetUpdate` and the headless task do before
 * the native side turns it into RemoteViews — so an invalid tree fails here.
 */
import React from 'react';
import { describe, expect, it } from '@jest/globals';
// Not re-exported from the package index, and only the sources carry types for
// it. It is the function the library runs on every render — `requestWidgetUpdate`
// and the headless task both call it — so it is the honest thing to draw against.
import { buildWidgetTree } from 'react-native-android-widget/src/api/build-widget-tree';
import { NextStepWidget, ANDROID_WIDGET_NAME } from '../android/NextStepWidget';
import { createWidgetTaskHandler, renderNextStepWidget } from '../android/widgetTaskHandler';
import { SNAPSHOT_TTL_MS, buildSnapshot, type WidgetLabels, type WidgetSnapshot } from '../snapshot';
import { parseLink } from '../../../links';
import type { Commitment } from '../../../api/schemas/common';
import ar from '../../../i18n/locales/ar.json';
import { widgetLabelsFor } from '../labels';
import { strings } from '../../../i18n/strings';

type Tree = { type: string; props: Record<string, unknown>; children?: Tree[] };

const NOW = new Date('2026-09-13T09:00:00.000Z');
const LABELS: WidgetLabels = widgetLabelsFor(strings.en);

function commitment(id: string, title: string): Commitment {
  return {
    id, kind: 'task', title, description: null, person: null, status: 'active',
    priority: { level: 'high', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: '2026-09-13T12:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:00:00.000Z',
    confirmedAt: '2026-09-01T09:00:00.000Z', completedAt: null, droppedAt: null,
  } as Commitment;
}

function snapshotFor(overrides: { locale?: 'en' | 'ar'; today?: Commitment[]; titlesAllowed?: boolean } = {}): WidgetSnapshot {
  const locale = overrides.locale ?? 'en';
  return buildSnapshot({
    today: overrides.today ?? [commitment('c1', 'Pay the rent'), commitment('c2', 'Call Sami')],
    nextStep: null,
    titlesAllowed: overrides.titlesAllowed ?? false,
    surface: 'widget',
    locale,
    labels: locale === 'ar' ? widgetLabelsFor(strings.ar) : LABELS,
    now: NOW,
    formatTime: () => '12:00',
  });
}

function draw(snapshot: WidgetSnapshot | null, now = NOW): Tree {
  return buildWidgetTree(
    <NextStepWidget snapshot={snapshot} now={now} scheme="light" fallback={{ labels: LABELS, direction: 'ltr' }} />,
  ) as Tree;
}

function all(tree: Tree): Tree[] {
  return [tree, ...(tree.children ?? []).flatMap(all)];
}

const texts = (tree: Tree) => all(tree).filter((node) => node.type === 'TextWidget').map((node) => node.props.text);
const uris = (tree: Tree) => all(tree)
  .map((node) => node.props.clickActionData as { uri?: string } | undefined)
  .filter((data): data is { uri: string } => typeof data?.uri === 'string')
  .map((data) => data.uri);

describe('NextStepWidget (Android)', () => {
  it('draws the items with the redaction the snapshot already applied, each opening itself', () => {
    const tree = draw(snapshotFor());
    expect(texts(tree)).toEqual(expect.arrayContaining([LABELS.nextStep, LABELS.capture, LABELS.privateCommitment, '12:00']));
    expect(texts(tree)).not.toContain('Pay the rent');
    expect(uris(tree)).toEqual(expect.arrayContaining([
      'maybesitter://capture?source=widget&input=voice',
      'maybesitter://commitments/c1',
      'maybesitter://commitments/c2',
    ]));
  });

  it('draws an empty day with the capture link', () => {
    const tree = draw(snapshotFor({ today: [] }));
    expect(texts(tree)).toContain(LABELS.empty);
    expect(uris(tree)).toContain('maybesitter://capture?source=widget&input=voice');
  });

  it('stops drawing items once the snapshot has expired, and says so', () => {
    const tree = draw(snapshotFor({ titlesAllowed: true }), new Date(NOW.getTime() + SNAPSHOT_TTL_MS));
    expect(texts(tree)).toContain(LABELS.stale);
    expect(texts(tree)).not.toContain('Pay the rent');
    expect(uris(tree)).not.toContain('maybesitter://commitments/c1');
    expect(uris(tree)).toContain('maybesitter://today');
  });

  it('lays out right to left for an Arabic snapshot, whatever the device direction', () => {
    const tree = draw(snapshotFor({ locale: 'ar' }));
    // `FlexWidget` becomes `LinearLayoutWidget` in the tree the native side gets.
    const rows = all(tree).filter((node) => node.type === 'LinearLayoutWidget' && node.props.clickAction === 'OPEN_URI'
      && String((node.props.clickActionData as { uri: string }).uri).startsWith('maybesitter://commitments/'));
    expect(rows.length).toBe(2);
    // Time first and the importance dot last: the row reads from the right.
    const [firstChild] = rows[0]!.children ?? [];
    expect(firstChild!.type).toBe('TextWidget');
    expect(firstChild!.props.text).toBe('12:00');
    const header = tree.children![0]!;
    expect(header.children![0]!.props.text).toBe(ar.widgetCapture);
    expect(texts(tree)).toContain(ar.widgetPrivateCommitment);
    expect(all(tree).some((node) => node.props.textAlign === 'right')).toBe(true);
  });

  it('lays out left to right for English', () => {
    const tree = draw(snapshotFor());
    const header = tree.children![0]!;
    expect(header.children![0]!.props.text).toBe(LABELS.nextStep);
    expect(all(tree).some((node) => node.props.textAlign === 'right')).toBe(false);
  });

  it('draws the phone-language fallback before any snapshot exists', () => {
    expect(texts(draw(null))).toContain(LABELS.stale);
  });
});

describe('the headless task', () => {
  it('renders from the stored snapshot, in both schemes, against the current time', async () => {
    const stored = JSON.stringify(snapshotFor());
    const drawn: unknown[] = [];
    const handler = createWidgetTaskHandler({
      loadSnapshot: async () => stored,
      now: () => NOW,
      fallback: async () => ({ labels: LABELS, direction: 'ltr' }),
    });
    const widgetInfo = { widgetName: ANDROID_WIDGET_NAME, widgetId: 1, width: 300, height: 150, screenInfo: {} as never };
    for (const widgetAction of ['WIDGET_ADDED', 'WIDGET_UPDATE', 'WIDGET_RESIZED', 'WIDGET_DELETED'] as const) {
      await handler({ widgetInfo, widgetAction, renderWidget: (w) => drawn.push(w) });
    }
    expect(drawn).toHaveLength(3);
    const rendered = await renderNextStepWidget({
      loadSnapshot: async () => stored, now: () => NOW, fallback: async () => ({ labels: LABELS, direction: 'ltr' }),
    });
    expect(texts(buildWidgetTree(rendered.dark) as Tree)).toContain(LABELS.privateCommitment);
  });

  it('treats an unreadable store as no snapshot rather than throwing', async () => {
    const rendered = await renderNextStepWidget({
      loadSnapshot: async () => '{not json', now: () => NOW, fallback: async () => ({ labels: LABELS, direction: 'ltr' }),
    });
    expect(texts(buildWidgetTree(rendered.light) as Tree)).toContain(LABELS.stale);
  });
});

describe('the links the widget writes', () => {
  it('are links the app’s own router opens', () => {
    const snapshot = snapshotFor();
    expect(parseLink(snapshot.links.capture)?.target).toEqual({ kind: 'capture', source: 'widget', input: 'voice' });
    expect(parseLink(snapshot.links.today)?.target).toEqual({ kind: 'screen', name: 'today' });
    // 'Call Sami' sorts before 'Pay the rent' at the same importance and time.
    expect(parseLink(snapshot.items[0]!.link)?.target).toEqual({ kind: 'commitment', id: 'c2' });
  });
});
