import { afterAll, beforeAll, describe, it, jest } from '@jest/globals';
import { NOW, ZONE } from './harness';

beforeAll(() => {
  process.env.TZ = ZONE;
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterAll(() => {
  jest.useRealTimers();
});

describe('M5b-2a device-only verification', () => {
  it.todo('R1 / R2 dense seeded account at default size and AX5 in ar/en/he: needs simulator');
});
