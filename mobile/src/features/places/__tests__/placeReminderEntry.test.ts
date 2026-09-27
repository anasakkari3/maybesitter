/**
 * The place-reminder task is defined by the real entry module (closure CL4).
 *
 * iOS and Android wake the app for a region crossing with no React tree: the
 * only code that runs is the bundle's entry. If `index.ts` stops defining the
 * task, every crossing lands on a task with no handler and nothing rings —
 * silently. So this loads `index.ts` itself, with the native pieces faked,
 * and asserts the task was defined, and defined before the app registers.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { PLACE_REMINDER_TASK } from '../placeReminderEngine';

const mockDefineTask = jest.fn();
const mockRegisterRoot = jest.fn();
jest.mock('expo-task-manager', () => ({
  __esModule: true,
  defineTask: (...args: unknown[]) => mockDefineTask(...args),
}));
jest.mock('expo', () => ({
  __esModule: true,
  registerRootComponent: (...args: unknown[]) => mockRegisterRoot(...args),
}));
jest.mock('react-native-android-widget', () => ({ __esModule: true, registerWidgetTaskHandler: () => undefined }));
jest.mock('../../../../App', () => ({ __esModule: true, default: () => null }));
jest.mock('../../widget/android/widgetTaskHandler', () => ({ __esModule: true, widgetTaskHandler: () => undefined }));

describe('the app entry', () => {
  it('defines the place-reminder task at module scope, before the app registers', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../../index');
    });
    const call = mockDefineTask.mock.calls.findIndex(args => args[0] === PLACE_REMINDER_TASK);
    expect(call).toBeGreaterThanOrEqual(0);
    expect(typeof mockDefineTask.mock.calls[call]![1]).toBe('function');
    expect(mockRegisterRoot).toHaveBeenCalledTimes(1);
    expect(mockDefineTask.mock.invocationCallOrder[call]!).toBeLessThan(mockRegisterRoot.mock.invocationCallOrder[0]!);
  });
});
