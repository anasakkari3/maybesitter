import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { DailyDigest, Item, ReminderAttempt, User } from '../types/index';

export const SINGLE_USER_ID = 'single-user';
const SCHEMA_VERSION = 1;

export interface AppSnapshot {
  user: User;
  items: Item[];
  dailyDigests: DailyDigest[];
  reminderAttempts: ReminderAttempt[];
}

export interface AppData extends AppSnapshot {
  schemaVersion: number;
}

const dataDirectory = process.env.MAYBESITTER_DATA_DIR || path.join(process.cwd(), '.maybesitter');
const dataFile = path.join(dataDirectory, 'data.json');

let writeQueue: Promise<unknown> = Promise.resolve();

export function generateServerId(): string {
  return randomUUID();
}

export function getDefaultUser(): User {
  return {
    id: SINGLE_USER_ID,
    email: 'single-user@maybesitter.local',
    name: 'Maybesitter User',
    createdAt: new Date().toISOString(),
    preferences: {
      reminderTime: '08:00',
      timezone: 'UTC',
      notificationsEnabled: true,
      dailyDigestEnabled: true,
      theme: 'light',
    },
  };
}

function emptyData(): AppData {
  return {
    schemaVersion: SCHEMA_VERSION,
    user: getDefaultUser(),
    items: [],
    dailyDigests: [],
    reminderAttempts: [],
  };
}

function normalizeData(raw: Partial<AppData> | null): AppData {
  const fallback = emptyData();
  const user = raw?.user && typeof raw.user === 'object'
    ? {
        ...fallback.user,
        ...raw.user,
        id: SINGLE_USER_ID,
        preferences: {
          ...fallback.user.preferences,
          ...raw.user.preferences,
        },
      }
    : fallback.user;

  return {
    schemaVersion: SCHEMA_VERSION,
    user,
    items: Array.isArray(raw?.items)
      ? raw.items.filter((item): item is Item => Boolean(item && typeof item.id === 'string')).map((item) => ({
          ...item,
          userId: SINGLE_USER_ID,
        }))
      : [],
    dailyDigests: Array.isArray(raw?.dailyDigests)
      ? raw.dailyDigests
          .filter((digest): digest is DailyDigest => Boolean(digest && typeof digest.id === 'string'))
          .map((digest) => ({ ...digest, userId: SINGLE_USER_ID }))
      : [],
    reminderAttempts: Array.isArray(raw?.reminderAttempts)
      ? raw.reminderAttempts
          .filter((attempt): attempt is ReminderAttempt => Boolean(attempt && typeof attempt.id === 'string'))
          .map((attempt) => ({
            ...attempt,
            userId: SINGLE_USER_ID,
            attemptNumber: attempt.attemptNumber || 1,
            nextRetryAt: attempt.nextRetryAt || null,
          }))
      : [],
  };
}

async function readDataUnlocked(): Promise<AppData> {
  try {
    const raw = await fs.readFile(dataFile, 'utf8');
    return normalizeData(JSON.parse(raw) as Partial<AppData>);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyData();
    }
    throw err;
  }
}

async function writeDataUnlocked(data: AppData): Promise<void> {
  await fs.mkdir(dataDirectory, { recursive: true });
  const tempFile = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(normalizeData(data), null, 2)}\n`, 'utf8');
  await fs.rename(tempFile, dataFile);
}

export async function getAppSnapshot(): Promise<AppSnapshot> {
  const data = await readDataUnlocked();
  return {
    user: data.user,
    items: data.items.filter((item) => item.userId === SINGLE_USER_ID),
    dailyDigests: data.dailyDigests.filter((digest) => digest.userId === SINGLE_USER_ID),
    reminderAttempts: data.reminderAttempts.filter((attempt) => attempt.userId === SINGLE_USER_ID),
  };
}

export async function updateAppData<T>(mutator: (data: AppData) => T | Promise<T>): Promise<T> {
  const operation = writeQueue.then(async () => {
    const data = await readDataUnlocked();
    const result = await mutator(data);
    data.schemaVersion = SCHEMA_VERSION;
    data.user.id = SINGLE_USER_ID;
    data.items = data.items.map((item) => ({ ...item, userId: SINGLE_USER_ID }));
    data.dailyDigests = data.dailyDigests.map((digest) => ({ ...digest, userId: SINGLE_USER_ID }));
    data.reminderAttempts = data.reminderAttempts.map((attempt) => ({ ...attempt, userId: SINGLE_USER_ID }));
    await writeDataUnlocked(data);
    return result;
  });

  writeQueue = operation.catch(() => undefined);
  return operation;
}

export function snapshotFromData(data: AppData): AppSnapshot {
  return {
    user: data.user,
    items: data.items.filter((item) => item.userId === SINGLE_USER_ID),
    dailyDigests: data.dailyDigests.filter((digest) => digest.userId === SINGLE_USER_ID),
    reminderAttempts: data.reminderAttempts.filter((attempt) => attempt.userId === SINGLE_USER_ID),
  };
}
