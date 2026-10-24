/**
 * M5a Gate B, shared harness (PLAN-M5a, APPROVED by Codex at round 68,
 * sha256 375e68db…; its Wire section is binding on shape).
 * Gate author: Claude, written before Task B's build. Every test must fail on
 * d9f940b8 for the reason its criterion names, except the parity guards,
 * which pin today's behaviour and pass on d9f940b8 by design (named "parity"
 * in the test title).
 *
 * Real routes in-process, fake auth, memory storage, the rules path (the M4a /
 * M4b harness), a fake Google behind `googleRuntime` (OAuth, Calendar freeBusy
 * and a Gmail that knows labels, reply headers, HTML bodies, paging and
 * history). The process clock is pinned to REFERENCE (Wednesday 2026-10-07
 * 10:00 Jerusalem). MAYBESITTER_ENV is `staging` (the intelligence gate needs
 * it, PLAN Release). Both M5a capabilities are on, and the durable control
 * document is provisioned and enabled, unless a test says otherwise.
 *
 * Copy belongs to the builders: only statuses, error codes, ids, shapes,
 * instants, headers and what is persisted are asserted.
 */
import assert from 'node:assert/strict';
import { applyTrustAction } from '../../../lib/pilot/pilotTrustStore.ts';
import { tokenFor } from '../../support/fakeAuth.ts';
import { createInMemoryKms } from '../../../lib/security/inMemoryKms.ts';
import { resetGoogleRuntimeForTests, setGoogleRuntimeForTests } from '../../../lib/integrations/google/googleRuntime.ts';
import type { ShareStructuredGenerator } from '../../../lib/llm/shareProvider.ts';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_PICKER_KEY, FAKE_REDIRECT, FakeGoogle } from '../../support/fakeGoogle.ts';
import {
  REFERENCE,
  TZ,
  TODAY,
  TOMORROW,
  at,
  begin as beginM4b,
  call,
  currentStorage,
  end as endM4b,
  savedCommitments,
  show,
  type Raw,
} from '../m4b/support.ts';

export { REFERENCE, TZ, TODAY, TOMORROW, at, call, currentStorage, savedCommitments, show };
export type { Raw };

const ENV_KEYS = [
  'MAYBESITTER_FEATURE_CALENDAR_CHOICE',
  'MAYBESITTER_KILL_SWITCH_CALENDAR_CHOICE',
  'MAYBESITTER_FEATURE_EMAIL_SOURCES',
  'MAYBESITTER_KILL_SWITCH_EMAIL_SOURCES',
  'MAYBESITTER_FEATURE_PROACTIVE_LOOP',
  'MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP',
] as const;
let saved: Record<string, string | undefined> | null = null;

export interface M5aSwitches {
  calendarChoice?: boolean;
  calendarChoiceKilled?: boolean;
  emailSources?: boolean;
  emailSourcesKilled?: boolean;
  /** The 2026-10-01 proactive loop (the intelligence gate). Default on. */
  proactiveLoop?: boolean;
  /** MAYBESITTER_ENV (default 'staging'). */
  environment?: string;
  /** Provision `system/m5aControls` (default: both enabled at epoch 0). `null` leaves it absent. */
  controls?: { email?: { epoch: number; enabled: boolean }; calendar?: { epoch: number; enabled: boolean } } | null;
}

export const CONTROLS_PATH = 'system/m5aControls';

export function setM5aSwitches(switches: M5aSwitches = {}): void {
  if (saved === null) saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const flag = (value: boolean | undefined, fallback: boolean) => ((value ?? fallback) ? 'true' : 'false');
  process.env.MAYBESITTER_FEATURE_CALENDAR_CHOICE = flag(switches.calendarChoice, true);
  process.env.MAYBESITTER_KILL_SWITCH_CALENDAR_CHOICE = flag(switches.calendarChoiceKilled, false);
  process.env.MAYBESITTER_FEATURE_EMAIL_SOURCES = flag(switches.emailSources, true);
  process.env.MAYBESITTER_KILL_SWITCH_EMAIL_SOURCES = flag(switches.emailSourcesKilled, false);
  process.env.MAYBESITTER_FEATURE_PROACTIVE_LOOP = flag(switches.proactiveLoop, true);
  process.env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP = 'false';
}

/** The capture harness on `staging`, clock at REFERENCE, M5a switches and controls set. */
export async function begin(switches: M5aSwitches = {}): Promise<string> {
  const uid = beginM4b({ environment: switches.environment ?? 'staging' });
  setM5aSwitches(switches);
  if (switches.controls !== null) {
    await currentStorage().set(CONTROLS_PATH, {
      email: switches.controls?.email ?? { epoch: 0, enabled: true },
      calendar: switches.controls?.calendar ?? { epoch: 0, enabled: true },
    });
  }
  return uid;
}

export function end(): void {
  endGoogle();
  if (saved) {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    saved = null;
  }
  endM4b();
}

export const NOW = () => new Date().toISOString();
export function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}
export function plusDays(iso: string, days: number): string {
  return plusMinutes(iso, days * 24 * 60);
}

/* ── a calls helper with arbitrary headers (the M4a `call` sends none) ── */

export async function callWith(
  uid: string,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  options: { params?: Record<string, string>; body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<Raw> {
  const { route, tokenFor, BASE } = await harnessInternals();
  const params = options.params ?? {};
  const concrete = Object.entries(params).reduce((p, [key, value]) => p.replace(`[${key}]`, value), path);
  const handler = await route(path, method);
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}`, ...(options.headers ?? {}) });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const search = options.query ? `?${new URLSearchParams(options.query).toString()}` : '';
  const response = await handler(
    new Request(`${BASE}/api/mobile/${concrete}${search}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }),
    { params: Promise.resolve(params) },
  );
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : {}; } catch { /* left as text */ }
  return { status: response.status, body };
}

/** The M5a header every M5a build sends (PLAN R1.1b, M5A-R10-001). */
export const CHOICE_HEADER = { 'X-MaybeSitter-Calendar-Choice': '1' };

async function harnessInternals(): Promise<{ route: (path: string, method: string) => Promise<any>; tokenFor: (uid: string) => string; BASE: string }> {
  const m4a = await import('../m4a/support.ts') as any;
  return { route: m4a.route, tokenFor, BASE: 'http://localhost:3000' };
}

/* ── the fake Google, extended for Gmail M5a needs ──────────────────── */

export interface M5aMessage {
  readonly id: string;
  readonly receivedAt: string;
  readonly subject?: string;
  /** The text/plain body (absent ⇒ only `html` is sent). */
  readonly text?: string;
  readonly html?: string;
  readonly sent?: boolean;
  readonly inReplyTo?: string;
  readonly category?: 'CATEGORY_PERSONAL' | 'CATEGORY_PROMOTIONS' | 'CATEGORY_UPDATES' | 'CATEGORY_SOCIAL';
  readonly from?: string;
}

export class M5aGoogle {
  readonly base = new FakeGoogle();
  messages: M5aMessage[] = [];
  /** Gmail history: each entry adds message ids at a history id. */
  history: Array<{ id: string; added: string[] }> = [];
  historyStart = '1000';
  listQueries: Array<{ q: string | null; maxResults: number; pageToken: string | null }> = [];
  gets: string[] = [];
  historyCalls = 0;
  /** Every Gmail call answers this status when set. */
  gmailStatus: number | null = null;
  /** Page tokens Gmail rejects (400 invalid pageToken). */
  rejectPageTokens = new Set<string>();

  get busy() { return this.base.busy; }
  set busy(value) { this.base.busy = value; }
  get account() { return this.base.account; }
  set account(value) { this.base.account = value; }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.origin === 'https://gmail.googleapis.com') return this.gmail(url);
    return this.base.fetch(input, init);
  };

  freeBusyCalls(): number {
    return this.base.calls.filter((entry) => entry.url.startsWith('https://www.googleapis.com/calendar/v3/freeBusy')).length;
  }

  private gmail(url: URL): Response {
    if (this.gmailStatus !== null) return json({ error: { code: this.gmailStatus } }, this.gmailStatus);
    if (url.pathname === '/gmail/v1/users/me/messages') {
      const q = url.searchParams.get('q');
      const maxResults = Number(url.searchParams.get('maxResults') ?? '100');
      const pageToken = url.searchParams.get('pageToken');
      this.listQueries.push({ q, maxResults, pageToken });
      // An expired token is refused once; a restarted listing gets fresh tokens (as Gmail does).
      if (pageToken && this.rejectPageTokens.delete(pageToken)) return json({ error: { code: 400, message: 'Invalid pageToken' } }, 400);
      const window = parseWindow(q);
      const matching = [...this.messages]
        .filter((message) => !window || (Date.parse(message.receivedAt) / 1000 >= window.after && Date.parse(message.receivedAt) / 1000 < window.before))
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
      const start = Number(pageToken ?? 0);
      const page = matching.slice(start, start + maxResults);
      const next = start + maxResults < matching.length ? String(start + maxResults) : undefined;
      return json({ ...(page.length ? { messages: page.map((message) => ({ id: message.id, threadId: message.id })) } : {}), ...(next ? { nextPageToken: next } : {}), resultSizeEstimate: matching.length });
    }
    if (url.pathname === '/gmail/v1/users/me/history') {
      this.historyCalls += 1;
      const startId = Number(url.searchParams.get('startHistoryId') ?? this.historyStart);
      const entries = this.history.filter((entry) => Number(entry.id) > startId);
      const latest = this.history.length ? this.history[this.history.length - 1]!.id : this.historyStart;
      return json({
        historyId: latest,
        ...(entries.length ? { history: entries.map((entry) => ({ id: entry.id, messagesAdded: entry.added.map((id) => ({ message: { id, threadId: id, labelIds: labelsOf(this.messages.find((m) => m.id === id)) } })) })) } : {}),
      });
    }
    if (url.pathname === '/gmail/v1/users/me/profile') return json({ emailAddress: this.base.account.email, historyId: this.historyStart });
    const match = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
    const message = match ? this.messages.find((candidate) => candidate.id === decodeURIComponent(match[1]!)) : undefined;
    if (match) this.gets.push(decodeURIComponent(match[1]!));
    if (!message) return json({ error: { code: 404 } }, 404);
    const headers = [
      { name: 'Subject', value: message.subject ?? '' },
      { name: 'From', value: message.from ?? (message.sent ? this.base.account.email : 'Friend <friend@example.com>') },
      { name: 'Date', value: new Date(message.receivedAt).toUTCString() },
      ...(message.inReplyTo ? [{ name: 'In-Reply-To', value: message.inReplyTo }, { name: 'References', value: message.inReplyTo }] : []),
    ];
    const part = (mimeType: string, data: string) => ({ mimeType, body: { size: data.length, data: Buffer.from(data, 'utf8').toString('base64url') } });
    const payload = message.text !== undefined && message.html !== undefined
      ? { mimeType: 'multipart/alternative', headers, parts: [part('text/plain', message.text), part('text/html', message.html)] }
      : message.text !== undefined
        ? { ...part('text/plain', message.text), headers }
        : { ...part('text/html', message.html ?? ''), headers };
    return json({ id: message.id, threadId: message.id, historyId: '9001', internalDate: String(Date.parse(message.receivedAt)), labelIds: labelsOf(message), payload });
  }
}

function labelsOf(message: M5aMessage | undefined): string[] {
  if (!message) return [];
  return message.sent ? ['SENT'] : ['INBOX', message.category ?? 'CATEGORY_PERSONAL'];
}

function parseWindow(q: string | null): { after: number; before: number } | null {
  if (!q) return null;
  const after = /after:(\d+)/.exec(q);
  const before = /before:(\d+)/.exec(q);
  if (!after || !before) return null;
  return { after: Number(after[1]), before: Number(before[1]) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let google: M5aGoogle | null = null;

/** A model double for the semantic pass: returns `observations(text)` for each analysed text, counting calls. */
export function semanticModel(observations: (text: string) => Array<{ kind: string; evidence: string; confidence: number }>): ShareStructuredGenerator & { calls: () => number } {
  let count = 0;
  const generate = (async (input: any) => {
    count += 1;
    const text = input.parts.filter((part: any) => part.kind === 'text').map((part: any) => part.text).join('\n');
    return { text: JSON.stringify({ observations: observations(text) }), model: 'fake', latencyMs: 1, promptTokens: 10, outputTokens: 10 };
  }) as ShareStructuredGenerator & { calls: () => number };
  generate.calls = () => count;
  return generate;
}

/** Installs the fake Google (and an optional model) on the harness storage. */
export function beginGoogle(model?: ShareStructuredGenerator): M5aGoogle {
  google = new M5aGoogle();
  const kms = createInMemoryKms();
  setGoogleRuntimeForTests({
    storage: currentStorage(),
    env: {
      ...process.env,
      GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URI: FAKE_REDIRECT,
      MAYBESITTER_KMS_KEY_NAME: kms.keyName,
      GOOGLE_PICKER_API_KEY: FAKE_PICKER_KEY,
    },
    secrets: null,
    fetchImpl: google.fetch as typeof fetch,
    encryption: { kms, env: { MAYBESITTER_KMS_KEY_NAME: kms.keyName } as unknown as NodeJS.ProcessEnv },
    ...(model ? { shareModel: model } : {}),
  } as any);
  return google;
}

export function endGoogle(): void {
  resetGoogleRuntimeForTests();
  google = null;
}

/** Connects Google with the given feature through the real routes (calendar consent recorded first for `calendar`). */
export async function connectGoogle(uid: string, feature: 'gmail' | 'calendar'): Promise<void> {
  assert.ok(google, 'call beginGoogle() first');
  const atNow = NOW();
  await applyTrustAction(uid, { type: 'record_first_value', at: atNow } as any);
  if (feature === 'calendar') await applyTrustAction(uid, { type: 'set_calendar_consent', granted: true, at: atNow } as any);
  const begun = await call(uid, 'integrations/google/connect', 'POST', { body: { feature } });
  assert.equal(begun.status, 200, show(begun.body));
  const granted = google!.base.consent(begun.body.authorizationUrl);
  const done = await call(uid, 'integrations/google/callback', 'POST', { body: granted });
  assert.equal(done.status, 200, show(done.body));
}

/** Records calendar consent in the Trust store (the device busy route requires it). */
export async function grantCalendarConsent(uid: string): Promise<void> {
  const atNow = NOW();
  await applyTrustAction(uid, { type: 'record_first_value', at: atNow } as any);
  await applyTrustAction(uid, { type: 'set_calendar_consent', granted: true, at: atNow } as any);
}

/* ── M5a scan helpers ───────────────────────────────────────────────── */

const SCAN_FEATURE_HEADERS = {
  'X-MaybeSitter-Client-Features': 'gmail-scan-daily-limit,gmail-scan-bulk,gmail-scan-unanalysed',
};

export function scanNew(uid: string, extra: Record<string, unknown> = {}): Promise<Raw> {
  return callWith(uid, 'intelligence/sources/gmail/scan', 'POST', {
    headers: SCAN_FEATURE_HEADERS,
    body: { m5: true, intent: 'new', timezone: TZ, ...extra },
  });
}

export function scanResume(uid: string, expectedScanId: string): Promise<Raw> {
  return callWith(uid, 'intelligence/sources/gmail/scan', 'POST', {
    headers: SCAN_FEATURE_HEADERS,
    body: { m5: true, intent: 'resume', expectedScanId, timezone: TZ },
  });
}

export function scanStatus(uid: string): Promise<Raw> {
  return callWith(uid, 'intelligence/sources/gmail/scan', 'GET', { headers: SCAN_FEATURE_HEADERS });
}

/** POSTs `resume` until the manual scan is terminal (bounded). Returns the last status body. */
export async function runScanToEnd(uid: string, limit = 40): Promise<any> {
  let status = (await scanStatus(uid)).body;
  for (let i = 0; i < limit; i += 1) {
    const manual = status?.manual;
    if (manual && manual.status !== 'running') return status;
    const scanId = manual?.scanId ?? manual?.id;
    const result = scanId ? await scanResume(uid, scanId) : await scanNew(uid);
    assert.ok(result.status < 500, show(result.body));
    status = (await scanStatus(uid)).body;
  }
  return status;
}

/* ── the named seams (the gate's, for Task B to export) ─────────────── */

/**
 * `runGmailJobTickForTests(route: 'live' | 'sweep', options?: { now?: Date })`
 * from `lib/intelligence/gmailJobs.ts`: one tick of the named job route's
 * classes, exactly as the internal job route runs it (PLAN R4.2 route
 * ownership), without the scheduler OIDC wrapper.
 */
export async function tick(route: 'live' | 'sweep', now?: string): Promise<any> {
  let module: Record<string, unknown>;
  try {
    module = await import('../../../lib/intelligence/gmailJobs.ts') as Record<string, unknown>;
  } catch (error) {
    assert.fail(`lib/intelligence/gmailJobs.ts not built (${(error as Error).message.split('\n')[0]})`);
  }
  const seam = module.runGmailJobTickForTests;
  assert.equal(typeof seam, 'function', 'runGmailJobTickForTests is not exported (the gate\'s named seam)');
  return (seam as any)(route, now ? { now: new Date(now) } : {});
}

/**
 * `ownTextOf(text: string)` from `lib/intelligence/ownText.ts` (PLAN R3.1
 * bound 2): `{ own, boundary: 'quote_header' | 'no_quote' | 'unknown' }`.
 */
export async function ownTextOf(text: string): Promise<{ own: string; boundary: string }> {
  let module: Record<string, unknown>;
  try {
    module = await import('../../../lib/intelligence/ownText.ts') as Record<string, unknown>;
  } catch (error) {
    assert.fail(`lib/intelligence/ownText.ts not built (${(error as Error).message.split('\n')[0]})`);
  }
  assert.equal(typeof module.ownTextOf, 'function', 'ownTextOf is not exported');
  return (module.ownTextOf as any)(text);
}
