/**
 * `POST /api/early-access`: the public website's "Join the test" form.
 *
 * The contract is `site/SIGNUP_CONTRACT.md`, and it is binding. A version of
 * this endpoint was deployed around 2026-09-13 from a commit that never
 * reached main (tag `archive/2026-09/stranded/local-main-launch-site`). That
 * code is the reference for the safe parts kept here: POST-only JSON, a 4 KiB
 * bound, same-origin only, a honeypot, a global rate limit, no IPs and
 * identical answers for new and known emails. It differs from the contract,
 * and the contract wins:
 *
 * - no `name`. The pages don't ask for one;
 * - `language`, `pageLanguage`, `knowsFounder`, `whatsappOptIn` and `v` are
 *   stored, because the message test is read from them;
 * - a phone number is stored **only** with `whatsappOptIn: true`, and that
 *   opt-in means "you may contact me about the test on WhatsApp", nothing more;
 * - there is no `/events` route and no page-view counting. The site has no
 *   analytics; the message test's denominator is the link taps each platform
 *   reports.
 *
 * Nothing in the stored record comes from the request's transport: no IP,
 * user-agent, cookie or visitor identifier is ever read into it.
 */
import { createHash } from 'node:crypto';
import { RequestBodyTooLargeError, readJsonBody } from '../net/requestBody';
import {
  EARLY_ACCESS_RATE_LIMITS,
  EARLY_ACCESS_REGISTRATIONS,
  getStorage,
  resolveStorageBackend,
  type StorageAdapter,
} from '../storage';

export const EARLY_ACCESS_BODY_LIMIT_BYTES = 4096;
/** Sign-ups the whole service accepts per hour. Global, so it needs no IP. */
export const EARLY_ACCESS_HOURLY_LIMIT = 1000;
const WINDOW_MS = 60 * 60 * 1000;

const DEVICES = ['iphone', 'android'] as const;
const LANGUAGES = ['ar', 'he', 'en'] as const;
const KNOWS_FOUNDER = ['yes', 'no'] as const;
const ARMS = ['a', 'b', 'none'] as const;

export type EarlyAccessDevice = (typeof DEVICES)[number];
export type EarlyAccessLanguage = (typeof LANGUAGES)[number];
export type EarlyAccessKnowsFounder = (typeof KNOWS_FOUNDER)[number];
export type EarlyAccessArm = (typeof ARMS)[number];

/** Exactly what is stored, and nothing else. `site/SIGNUP_CONTRACT.md` and the privacy policy promise this list. */
export interface EarlyAccessRegistration {
  email: string;
  device: EarlyAccessDevice;
  language: EarlyAccessLanguage;
  pageLanguage: EarlyAccessLanguage;
  knowsFounder: EarlyAccessKnowsFounder;
  whatsappOptIn: boolean;
  /** `null` unless `whatsappOptIn` is true. A number is never marketing consent. */
  phone: string | null;
  source: string;
  v: EarlyAccessArm;
  registeredAt: string;
}

export type EarlyAccessField =
  | 'email' | 'device' | 'language' | 'pageLanguage' | 'knowsFounder' | 'whatsappOptIn' | 'phone' | 'v';

export interface EarlyAccessStore {
  /** Counts one sign-up against the global window; false once the window is full. */
  allow(now: number, limit: number): Promise<boolean>;
  /** First registration wins. Returns false, without writing, when the email is already registered. */
  register(value: EarlyAccessRegistration): Promise<boolean>;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The registration document for a normalised email. The email itself never appears in the path. */
export function registrationPath(email: string): string {
  return `${EARLY_ACCESS_REGISTRATIONS}/${digest(email)}`;
}

/** The single global rate-limit document. */
export const RATE_LIMIT_PATH = `${EARLY_ACCESS_RATE_LIMITS}/registrations`;

export function createEarlyAccessStore(storage: StorageAdapter): EarlyAccessStore {
  return {
    allow: (now, limit) => storage.runTransaction(async (tx) => {
      const existing = await tx.get<{ count: number; resetsAt: number }>(RATE_LIMIT_PATH);
      const current = existing && existing.resetsAt > now ? existing : { count: 0, resetsAt: now + WINDOW_MS };
      if (current.count >= limit) return false;
      tx.set(RATE_LIMIT_PATH, { count: current.count + 1, resetsAt: current.resetsAt });
      return true;
    }),
    register: (value) => storage.runTransaction(async (tx) => {
      const path = registrationPath(value.email);
      if (await tx.get(path)) return false;
      tx.create(path, value);
      return true;
    }),
  };
}

/** Durable storage only: a sign-up acknowledged into the in-memory development store would be a lie. */
export function productionEarlyAccessStore(): EarlyAccessStore {
  if (resolveStorageBackend() !== 'firestore') throw new Error('early access requires durable Firestore storage');
  return createEarlyAccessStore(getStorage());
}

/** `[A-Za-z0-9_-]{1,64}`, lower-cased; anything else is `direct`. */
export function sourceOf(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value.toLowerCase() : 'direct';
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
// Constructed rather than a literal: the repo's TS target rejects the `u` flag on literals.
const CONTROL = new RegExp('[\\p{Cc}\\p{Cf}]', 'u');
const PHONE = /^\+?[\d\s().-]{7,30}$/;

export type Validation =
  | { ok: true; value: Omit<EarlyAccessRegistration, 'registeredAt'> }
  | { ok: false; fields: EarlyAccessField[] };

/**
 * The contract's request shape, normalised. Unknown keys, a `name` among them,
 * are ignored and never stored.
 */
export function validateEarlyAccess(body: Record<string, unknown>): Validation {
  const fields: EarlyAccessField[] = [];

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || CONTROL.test(email) || !EMAIL.test(email)) fields.push('email');
  if (!oneOf(DEVICES, body.device)) fields.push('device');
  if (!oneOf(LANGUAGES, body.language)) fields.push('language');
  if (!oneOf(LANGUAGES, body.pageLanguage)) fields.push('pageLanguage');
  if (!oneOf(KNOWS_FOUNDER, body.knowsFounder)) fields.push('knowsFounder');
  if (!oneOf(ARMS, body.v)) fields.push('v');
  if (typeof body.whatsappOptIn !== 'boolean') fields.push('whatsappOptIn');

  // The one consent boundary in this endpoint: without the opt-in, a number is
  // dropped whatever was sent, never stored "in case".
  const whatsappOptIn = body.whatsappOptIn === true;
  let phone: string | null = null;
  if (whatsappOptIn) {
    const raw = typeof body.phone === 'string' ? body.phone.trim() : '';
    const digits = raw.replace(/\D/g, '');
    if (!PHONE.test(raw) || digits.length < 7 || digits.length > 15) fields.push('phone');
    else phone = raw;
  }

  if (fields.length) return { ok: false, fields };
  return {
    ok: true,
    value: {
      email,
      device: body.device as EarlyAccessDevice,
      language: body.language as EarlyAccessLanguage,
      pageLanguage: body.pageLanguage as EarlyAccessLanguage,
      knowsFounder: body.knowsFounder as EarlyAccessKnowsFounder,
      whatsappOptIn,
      phone,
      source: sourceOf(body.source),
      v: body.v as EarlyAccessArm,
    },
  };
}

const respond = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });

/** The shared streaming reader (`lib/net/requestBody.ts`), at this form's own 4 KiB bound. */
async function boundedJson(request: Request): Promise<unknown> {
  return readJsonBody(request, { limitBytes: EARLY_ACCESS_BODY_LIMIT_BYTES });
}

/**
 * Origins allowed to post. On Cloud Run, only `MAYBESITTER_SITE_ORIGINS`
 * (comma-separated, exact). Unset means every request is refused, so a
 * missing setting fails closed. Off Cloud Run, a same-origin request is also
 * accepted, for local previews.
 */
function originAllowed(request: Request, env: NodeJS.ProcessEnv): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const configured = (env.MAYBESITTER_SITE_ORIGINS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (configured.includes(origin)) return true;
  const local = !env.K_SERVICE && env.NODE_ENV !== 'production';
  return local && origin === new URL(request.url).origin;
}

export interface EarlyAccessOptions {
  storeFactory?: () => EarlyAccessStore;
  now?: () => number;
  hourlyLimit?: number;
  env?: NodeJS.ProcessEnv;
}

export async function handleEarlyAccess(request: Request, options: EarlyAccessOptions = {}): Promise<Response> {
  const env = options.env ?? process.env;
  if (request.method !== 'POST') return respond({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  if (!originAllowed(request, env)) return respond({ error: 'forbidden_origin' }, 403);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return respond({ error: 'unsupported_media_type' }, 415);
  }
  if (Number(request.headers.get('content-length') || 0) > EARLY_ACCESS_BODY_LIMIT_BYTES) {
    return respond({ error: 'payload_too_large' }, 413);
  }

  let body: unknown;
  try {
    body = await boundedJson(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return respond({ error: 'payload_too_large' }, 413);
    return respond({ error: 'invalid_json' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return respond({ error: 'invalid_json' }, 400);
  const fields = body as Record<string, unknown>;

  // A bot filled the field people never see. Answer as if it worked, and touch nothing.
  if (fields.website !== undefined && fields.website !== '') return respond({ ok: true }, 200);

  const validation = validateEarlyAccess(fields);
  if (!validation.ok) return respond({ error: 'invalid_fields', fields: validation.fields }, 422);

  try {
    const store = (options.storeFactory ?? productionEarlyAccessStore)();
    const now = (options.now ?? Date.now)();
    if (!(await store.allow(now, options.hourlyLimit ?? EARLY_ACCESS_HOURLY_LIMIT))) {
      return respond({ error: 'rate_limited' }, 429, { 'Retry-After': '3600' });
    }
    // First registration wins, and the answer is the same either way, so the
    // endpoint never reveals whether an email is already on the list.
    await store.register({ ...validation.value, registeredAt: new Date(now).toISOString() });
    return respond({ ok: true }, 200);
  } catch {
    return respond({ error: 'unavailable' }, 503, { 'Retry-After': '30' });
  }
}
