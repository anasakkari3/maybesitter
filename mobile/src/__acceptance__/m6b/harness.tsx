import { jest } from '@jest/globals';
import {
  prepareM6,
  type Language,
  type M6Harness,
  type M6Options,
} from '../m6/harness';
import type { RouteHandler, RouteReply } from '../m5b/harness';

export {
  NOW,
  Providers,
  ZONE,
  fact,
  flatStyle,
  teardown,
  waitForRequest,
} from '../m6/harness';

export const DISCLOSURE_VERSION = 'memory-translation-disclosure-v1';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

export interface M6bOptions extends Omit<M6Options, 'handler'> {
  capability?: RouteReply | Promise<RouteReply>;
  handler?: RouteHandler;
}

export interface M6bHarness extends M6Harness {
  translationSignals: { path: string; signal: AbortSignal | undefined }[];
}

export async function prepareM6b(
  language: Language = 'en',
  options: M6bOptions = {},
): Promise<M6bHarness> {
  const route: RouteHandler = async request => {
    const custom = await options.handler?.(request);
    if (custom !== undefined) return custom;
    if (request.path === '/api/mobile/capabilities/m6b') {
      return options.capability ?? {
        status: 200,
        body: {
          success: true,
          memoryTranslation: true,
          disclosureVersion: DISCLOSURE_VERSION,
        },
      };
    }
    return undefined;
  };
  const harness = await prepareM6(language, { ...options, handler: route });
  const installedFetch = globalThis.fetch;
  const translationSignals: M6bHarness['translationSignals'] = [];

  (globalThis as { fetch: typeof fetch }).fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const path = new URL(rawUrl, 'http://localhost').pathname;
      if (init?.method === 'POST' && /^\/api\/mobile\/memory\/[^/]+\/translation$/.test(path)) {
        translationSignals.push({ path, signal: init.signal ?? undefined });
      }
      return installedFetch(input, init);
    },
  ) as typeof fetch;

  return { ...harness, translationSignals };
}

export const translationPath = (id: string) => new RegExp(
  `^/api/mobile/memory/${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/translation$`,
);

