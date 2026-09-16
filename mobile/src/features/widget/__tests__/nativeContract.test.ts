/**
 * The JS writer and the Swift reader agree (UC-3.R1, #203).
 *
 * Xcode is not in the Jest loop, so a renamed key, a changed App Group or a
 * field the app stopped writing would compile on both sides and leave the
 * widget reading nothing on a device. This reads the committed Swift and the
 * target config as text and holds them to the constants the app writes with.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_GROUP, SNAPSHOT_KEY, buildSnapshot } from '../snapshot';
import { widgetLabelsFor } from '../labels';
import { strings } from '../../../i18n/strings';

const TARGET = join(__dirname, '..', '..', '..', '..', 'targets', 'widget');
const swift = readFileSync(join(TARGET, 'Snapshot.swift'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS config file, read as the plugin reads it.
const targetConfig = require(join(TARGET, 'expo-target.config.js'))() as {
  type: string;
  deploymentTarget: string;
  entitlements: Record<string, string[]>;
};

describe('the widget extension', () => {
  it('reads the App Group and key the app writes to', () => {
    expect(swift).toContain(`static let appGroup = "${APP_GROUP}"`);
    expect(swift).toContain(`static let snapshotKey = "${SNAPSHOT_KEY}"`);
    expect(targetConfig.type).toBe('widget');
    expect(targetConfig.entitlements['com.apple.security.application-groups']).toEqual([APP_GROUP]);
  });

  it('decodes only fields the snapshot actually carries', () => {
    const snapshot = buildSnapshot({
      today: [],
      nextStep: { commitmentId: 'c1', title: 'x' },
      titlesAllowed: false,
      surface: 'widget',
      locale: 'ar',
      labels: widgetLabelsFor(strings.ar),
      now: new Date('2026-09-13T09:00:00.000Z'),
      formatTime: () => '',
    });
    const declared = (block: string) => {
      const body = swift.split(`struct ${block}: Decodable {`)[1]!.split('\n}')[0]!;
      return [...body.matchAll(/let (\w+):/g)].map((m) => m[1]!);
    };
    for (const field of declared('WidgetSnapshot')) expect(Object.keys(snapshot)).toContain(field);
    for (const field of declared('WidgetSnapshotItem')) expect(Object.keys(snapshot.items[0]!)).toContain(field);
    for (const field of declared('WidgetLabels')) expect(Object.keys(snapshot.labels)).toContain(field);
  });

  it('reads the lock-screen families as the lock-screen surface and hides titles while locked', () => {
    const view = readFileSync(join(TARGET, 'NextStepWidget.swift'), 'utf8');
    expect(view).toMatch(/case \.accessoryInline, \.accessoryRectangular: return \.lockScreen/);
    expect(view).toContain('snapshot.safeItems(on: surface)');
    // Every place a title is drawn is privacy-sensitive.
    const titleDraws = view.split('\n').filter((line) => /Text\((item|first)\.(title|timeLabel)/.test(line));
    expect(titleDraws.length).toBeGreaterThanOrEqual(3);
    expect((view.match(/\.privacySensitive\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('declares its own App Group UserDefaults reason in its privacy manifest', () => {
    const manifest = readFileSync(join(TARGET, 'PrivacyInfo.xcprivacy'), 'utf8');
    expect(manifest).toContain('NSPrivacyAccessedAPICategoryUserDefaults');
    expect(manifest).toContain('<string>1C8F.1</string>');
  });
});
