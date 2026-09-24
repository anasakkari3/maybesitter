import { expect, it, jest } from '@jest/globals';
import { createReplayController, type ReplayContext } from '../controller';
import type { ClaritySdk } from '../native';
import { screenContext, SCREEN_FLOWS, STAGES } from '../policy';
import { clarityEnabled } from '../config';

const context: ReplayContext = { screen: 'capture_input', flow: 'capture', locale: 'ar', theme: 'dark', environment: 'staging', platform: 'ios' };
function setup() {
  let session: () => void = () => {};
  let fresh: () => void = () => {};
  const sdk = {
    LogLevel: { None: 'None' }, initialize: jest.fn(),
    setOnSessionStartedCallback: jest.fn((callback: () => void) => { session = callback; return true; }),
    startNewSession: jest.fn((callback: () => void) => { fresh = callback; }),
    pause: jest.fn(async () => true), resume: jest.fn(async () => true),
    consent: jest.fn(async (_ads: boolean, _analytics: boolean) => true), setCustomTag: jest.fn(async (_key: string, _value: string) => true),
    setCurrentScreenName: jest.fn(async (_screen: string) => true), sendCustomEvent: jest.fn(async (_event: string) => true),
  };
  const load = jest.fn(() => sdk as unknown as ClaritySdk);
  return { controller: createReplayController(load), sdk, load, session: () => session(), fresh: () => fresh() };
}

it('does not even import the SDK without both build enablement and explicit consent', () => {
  const { controller, load } = setup();
  controller.update(context, false, true);
  controller.update(context, true, false);
  controller.update(null, true, true);
  expect(load).not.toHaveBeenCalled();
});

it('initializes once, waits for native readiness, and uses advertising-denied consent', async () => {
  const { controller, sdk, session } = setup();
  controller.update(context, true, true);
  expect(sdk.initialize).toHaveBeenCalledWith('ymeq5r7uc6', { logLevel: 'None' });
  expect(sdk.resume).not.toHaveBeenCalled();
  session(); await controller.settled();
  expect(sdk.consent).toHaveBeenCalledWith(false, true);
  expect(sdk.setCurrentScreenName).toHaveBeenCalledWith('capture_input');
  expect(Object.fromEntries(sdk.setCustomTag.mock.calls)).toEqual({
    flow: 'capture', locale: 'ar', theme: 'dark', environment: 'staging', platform: 'ios', privacy: 'strict-v1', client: 'react_native',
  });
  controller.update({ ...context, screen: 'capture_review' }, true, true);
  await controller.settled();
  expect(sdk.initialize).toHaveBeenCalledTimes(1);
  expect(sdk.setCurrentScreenName).toHaveBeenLastCalledWith('capture_review');
});

it('a late startup callback cannot restart recording after revocation', async () => {
  const { controller, sdk, session } = setup();
  controller.update(context, true, true);
  controller.stop();
  session(); await controller.settled();
  expect(sdk.pause).toHaveBeenCalled();
  expect(sdk.consent).toHaveBeenLastCalledWith(false, false);
  expect(sdk.resume).not.toHaveBeenCalled();
  expect(sdk.setCustomTag).not.toHaveBeenCalled();
});

it('revocation interrupts a queued tag operation before resume', async () => {
  const { controller, sdk, session } = setup();
  let finish!: (value: boolean) => void;
  sdk.setCurrentScreenName.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  controller.update(context, true, true); session();
  await Promise.resolve(); await Promise.resolve();
  controller.stop(); finish(true);
  await controller.settled();
  expect(sdk.resume).not.toHaveBeenCalled();
  expect(sdk.setCustomTag).not.toHaveBeenCalled();
});

it('stops again when an in-flight native resume resolves after revoke', async () => {
  const { controller, sdk, session } = setup();
  let finish!: (value: boolean) => void;
  sdk.resume.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  controller.update(context, true, true); session();
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(finish).toBeDefined();
  controller.stop(); const pauses = sdk.pause.mock.calls.length;
  finish(true); await controller.settled();
  expect(sdk.pause.mock.calls.length).toBeGreaterThan(pauses);
});

it('new consent after an account boundary starts a fresh session and ignores late callbacks', async () => {
  const { controller, sdk, session, fresh } = setup();
  controller.update(context, true, true); session(); await controller.settled();
  controller.stop();
  controller.update(context, true, true);
  expect(sdk.startNewSession).toHaveBeenCalledTimes(1);
  controller.stop(); fresh(); await controller.settled();
  expect(sdk.resume).toHaveBeenCalledTimes(1);
});

it('handles missing native modules without breaking the app', () => {
  expect(() => createReplayController(() => null).update(context, true, true)).not.toThrow();
});

it('fails closed on native rejection or refused consent', async () => {
  for (const failure of ['reject', 'false']) {
    const { controller, sdk, session } = setup();
    if (failure === 'reject') sdk.consent.mockRejectedValueOnce(new Error('native failure'));
    else sdk.consent.mockResolvedValueOnce(false);
    controller.update(context, true, true); session(); await controller.settled();
    expect(sdk.pause).toHaveBeenCalled();
    expect(sdk.resume).not.toHaveBeenCalled();
  }
});

it('drops arbitrary metadata and events, and never reports events without consent', async () => {
  const { controller, sdk, session, load } = setup();
  controller.update({ ...context, screen: 'call the clinic' } as never, true, true);
  controller.update({ ...context, locale: 'person@example.com' } as never, true, true);
  expect(load).not.toHaveBeenCalled();
  controller.event('capture_saved');
  controller.update(context, true, true); session(); await controller.settled();
  controller.event('call the clinic' as never);
  controller.event('capture_saved');
  controller.stop(); controller.event('goal_confirmed');
  expect(sdk.sendCustomEvent.mock.calls).toEqual([['capture_saved']]);
});

it('maps all routes and known stages while excluding account, health and finance surfaces', () => {
  for (const screen of ['account', 'deleteAccount', 'financialContext', 'readinessSettings', 'calendarDemo']) {
    expect(screenContext(screen as never, null)).toBeNull();
  }
  expect(screenContext('unknown' as never, null)).toBeNull();
  expect(screenContext('today', 'secret' as never)).toBeNull();
  for (const stage of STAGES) expect(screenContext('today', stage)?.screen).toBe(stage);
  expect(screenContext('aiImport', 'ai_import_review')?.flow).toBe('ai_import');
  expect(Object.keys(SCREEN_FLOWS).length).toBeGreaterThan(40);
});

it('build switch fails closed on missing or mistyped configuration', () => {
  const original = process.env.EXPO_PUBLIC_CLARITY_ENABLED;
  try {
    for (const flag of ['', 'false', 'TRUE', '1']) {
      process.env.EXPO_PUBLIC_CLARITY_ENABLED = flag;
      expect(clarityEnabled()).toBe(false);
    }
    process.env.EXPO_PUBLIC_CLARITY_ENABLED = 'true'; expect(clarityEnabled()).toBe(true);
  } finally {
    if (original === undefined) delete process.env.EXPO_PUBLIC_CLARITY_ENABLED;
    else process.env.EXPO_PUBLIC_CLARITY_ENABLED = original;
  }
});
