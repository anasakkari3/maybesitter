import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Platform } from 'react-native';
import {
  ANDROID_AUDIO_CONTENT_SONIFICATION,
  ANDROID_AUDIO_USAGE_ALARM,
  ANDROID_CHANNELS,
  ANDROID_IMPORTANCE_DEFAULT,
  ANDROID_IMPORTANCE_HIGH,
  AWARENESS_CATEGORY_ID,
  HARD_CATEGORY_ID,
  HARD_CHANNEL_ID,
  HARD_SOUND,
  PLAN_CATEGORY_ID,
} from '../channels';
import { configureNotifications, resetNotificationSetupForTests } from '../setup';
import { createExpoGateway } from '../gateway';

/**
 * The channels and categories the app creates (UC-3.11 #196, UC-3.12a #197).
 *
 * The first block exists because of a defect: `channels.ts` passed `3` as the
 * default importance, which is Android's number for DEFAULT and
 * expo-notifications' for MIN. The jest mock carried the same wrong numbers, so
 * the suite agreed with itself. These read the enum out of the library's own
 * build, not out of the mock.
 */
const types = jest.requireActual<{
  AndroidImportance: Record<string, number>;
  AndroidAudioUsage: Record<string, number>;
  AndroidAudioContentType: Record<string, number>;
}>('expo-notifications/build/NotificationChannelManager.types');

const names = {
  notifChannelGeneral: 'General',
  notifChannelAwareness: 'Gentle',
  notifChannelHard: 'Must',
};

describe('the numbers handed to expo-notifications', () => {
  it('are expo s own enum values, not Android s', () => {
    expect(ANDROID_IMPORTANCE_DEFAULT).toBe(types.AndroidImportance.DEFAULT);
    expect(ANDROID_IMPORTANCE_HIGH).toBe(types.AndroidImportance.HIGH);
    expect(ANDROID_AUDIO_USAGE_ALARM).toBe(types.AndroidAudioUsage.ALARM);
    expect(ANDROID_AUDIO_CONTENT_SONIFICATION).toBe(types.AndroidAudioContentType.SONIFICATION);
    // The value that shipped in #196 and silenced the gentle channel.
    expect(types.AndroidImportance.MIN).toBe(3);
    expect(ANDROID_CHANNELS.some(channel => channel.importance === types.AndroidImportance.MIN)).toBe(false);
  });
});

describe('the Must channel (#197)', () => {
  const hard = ANDROID_CHANNELS.find(channel => channel.id === HARD_CHANNEL_ID);

  it('is the one HIGH channel, with the bundled sound as alarm audio', () => {
    expect(hard).toMatchObject({
      id: 'maybesitter_hard',
      importance: types.AndroidImportance.HIGH,
      sound: 'maybesitter_hard.wav',
      alarmAudio: true,
      enableLights: true,
    });
    expect(hard?.vibrationPattern?.length).toBeGreaterThan(0);
    expect(ANDROID_CHANNELS.filter(channel => channel.importance >= types.AndroidImportance.HIGH!))
      .toEqual([hard]);
  });

  it('names a sound file that is in the app and in the plugin s sounds list', () => {
    expect(HARD_SOUND).toBe('maybesitter_hard.wav');
    const root = join(__dirname, '..', '..', '..');
    expect(existsSync(join(root, 'assets', 'sounds', HARD_SOUND))).toBe(true);
    // Read, not imported: app.config.ts reads env at load. The plugin bundles
    // what this list names, and a sound not in it is silence on both platforms.
    const config = readFileSync(join(root, 'app.config.ts'), 'utf8');
    expect(config).toContain(`./assets/sounds/${HARD_SOUND}`);
  });

  it('uses the category id #198 sends and #200 attaches its buttons to', () => {
    expect(HARD_CATEGORY_ID).toBe('com.maybesitter.notification.category.hard');
  });
});

describe('setup', () => {
  const originalOs = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
    resetNotificationSetupForTests();
    jest.restoreAllMocks();
  });

  it('creates the Must channel with alarm audio and registers the Must category', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const Notifications = jest.requireMock<typeof import('expo-notifications')>('expo-notifications');
    const channel = jest.spyOn(Notifications, 'setNotificationChannelAsync');
    const category = jest.spyOn(Notifications, 'setNotificationCategoryAsync');

    await configureNotifications(names);

    expect(category.mock.calls.map(call => call[0]).sort())
      .toEqual([AWARENESS_CATEGORY_ID, HARD_CATEGORY_ID, PLAN_CATEGORY_ID].sort());
    const hardCall = channel.mock.calls.find(call => call[0] === HARD_CHANNEL_ID);
    expect(hardCall?.[1]).toEqual({
      name: 'Must',
      importance: types.AndroidImportance.HIGH,
      sound: HARD_SOUND,
      audioAttributes: {
        usage: types.AndroidAudioUsage.ALARM,
        contentType: types.AndroidAudioContentType.SONIFICATION,
      },
      vibrationPattern: [0, 400, 250, 400],
      enableLights: true,
    });
    // The gentle channels carry no sound override and no alarm audio.
    for (const id of ['maybesitter_general', 'maybesitter_awareness']) {
      expect(channel.mock.calls.find(call => call[0] === id)?.[1]).toEqual({
        name: id === 'maybesitter_general' ? 'General' : 'Gentle',
        importance: types.AndroidImportance.DEFAULT,
      });
    }
  });
});

describe('the gateway', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes the sound and the interruption level through, and nothing when a stage has none', async () => {
    const Notifications = jest.requireMock<typeof import('expo-notifications')>('expo-notifications');
    const schedule = jest.spyOn(Notifications, 'scheduleNotificationAsync');
    const gateway = createExpoGateway();
    const at = new Date(Date.UTC(2030, 0, 1, 12));

    await gateway.schedule({
      identifier: 'm1:strong', title: 'T', body: 'B', data: { commitmentId: 'm1' },
      categoryIdentifier: HARD_CATEGORY_ID, channelId: HARD_CHANNEL_ID,
      sound: HARD_SOUND, interruptionLevel: 'timeSensitive', at,
    });
    await gateway.schedule({
      identifier: 'm1:soft', title: 't', body: 'b', data: { commitmentId: 'm1' },
      categoryIdentifier: AWARENESS_CATEGORY_ID, channelId: 'maybesitter_awareness', at,
    });

    const [strong, soft] = schedule.mock.calls.map(call => call[0]);
    expect(strong?.content).toMatchObject({ sound: HARD_SOUND, interruptionLevel: 'timeSensitive', categoryIdentifier: HARD_CATEGORY_ID });
    expect(strong?.trigger).toMatchObject({ channelId: HARD_CHANNEL_ID });
    expect(soft?.content).not.toHaveProperty('sound');
    expect(soft?.content).not.toHaveProperty('interruptionLevel');
  });
});
