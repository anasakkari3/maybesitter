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
 * - the 2026-09-30 name/email dialog stores `name`; earlier current and
 *   stranded legacy forms remain compatible and do not store the old name;
 * - `language`, `pageLanguage`, `knowsFounder`, `whatsappOptIn` and `v` are
 *   stored, because the message test is read from them;
 * - a phone number is stored **only** with `whatsappOptIn: true`, and that
 *   opt-in means "you may contact me about the test on WhatsApp", nothing more;
 * - there is no page-view counting. The site has no analytics; the message
 *   test's denominator is the link taps each platform reports.
 *
 * **The legacy shape.** Until main's `site/` is on Hosting, the page people
 * load at maybesitter.com is still the stranded launch page. It posts
 * `{name, email, device, phone, website, source}` with no `v`, and pings
 * `/api/early-access/events`. So that a production deploy of main does not
 * break that page, a body with *none* of the current-only fields
 * (`LEGACY_DISCRIMINATOR_FIELDS`) is read as the legacy shape
 * (`validateLegacyEarlyAccess`) and stored with `v: 'legacy'`. It stores only
 * what the current privacy policy lists: no `name` (the policy says we do
 * not ask for one) and no `phone` (the policy stores a number only with the
 * WhatsApp opt-in, which the legacy page never asked for, so it is dropped
 * rather than turned into a consent nobody gave). `/events` is answered 204
 * and counts nothing (`handleEarlyAccessEvent`).
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

/**
 * The `v` stored for a sign-up from the stranded launch page. It is never
 * accepted from a request: a body that sends any `v` is the current shape.
 */
export const LEGACY_ARM = 'legacy';
/** The legacy page is English-only (`<html lang="en">`); this is the page it was, not a preference it asked for. */
export const LEGACY_PAGE_LANGUAGE: EarlyAccessLanguage = 'en';
/**
 * Fields only the current site sends. A body carrying any of them is held to
 * the current contract, so a current-site bug that drops `v` is a 422, not a
 * quiet legacy row, and nobody can smuggle `whatsappOptIn` + `phone` through
 * the legacy path.
 */
export const LEGACY_DISCRIMINATOR_FIELDS = ['v', 'language', 'pageLanguage', 'knowsFounder', 'whatsappOptIn'] as const;

/** Exactly what is stored, and nothing else. `site/SIGNUP_CONTRACT.md` and the privacy policy promise this list. */
export interface EarlyAccessRegistration {
  email: string;
  /** Supplied only by the simplified website interest form; older registrations have no name. */
  name?: string;
  device: EarlyAccessDevice;
  language: EarlyAccessLanguage;
  pageLanguage: EarlyAccessLanguage;
  /** `null` only on a legacy sign-up: that page never asked. */
  knowsFounder: EarlyAccessKnowsFounder | null;
  whatsappOptIn: boolean;
  /** `null` unless `whatsappOptIn` is true. A number is never marketing consent. */
  phone: string | null;
  source: string;
  v: EarlyAccessArm | typeof LEGACY_ARM;
  registeredAt: string;
}

export type EarlyAccessField =
  | 'name' | 'email' | 'device' | 'language' | 'pageLanguage' | 'knowsFounder' | 'whatsappOptIn' | 'phone' | 'v';

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
 * The previous form's request shape, normalised. Unknown keys, including a
 * `name` on that shape, are ignored and never stored.
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

/** The public landing modal asks for only a name and email. The clicked card supplies device. */
export function validateLandingInterest(body: Record<string, unknown>): Validation {
  const fields: EarlyAccessField[] = [];
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!name || name.length > 80 || CONTROL.test(name)) fields.push('name');
  if (!email || email.length > 254 || CONTROL.test(email) || !EMAIL.test(email)) fields.push('email');
  if (!oneOf(DEVICES, body.device)) fields.push('device');
  if (!oneOf(LANGUAGES, body.pageLanguage)) fields.push('pageLanguage');
  if (!oneOf(ARMS, body.v)) fields.push('v');
  if (fields.length) return { ok: false, fields };
  return {
    ok: true,
    value: {
      name,
      email,
      device: body.device as EarlyAccessDevice,
      // This is the page language, not a language preference supplied by the person.
      language: body.pageLanguage as EarlyAccessLanguage,
      pageLanguage: body.pageLanguage as EarlyAccessLanguage,
      knowsFounder: null,
      whatsappOptIn: false,
      phone: null,
      source: sourceOf(body.source),
      v: body.v as EarlyAccessArm,
    },
  };
}

/** True when the body is the stranded launch page's: none of the current-only fields is present. */
export function isLegacyShape(body: Record<string, unknown>): boolean {
  return LEGACY_DISCRIMINATOR_FIELDS.every((key) => body[key] === undefined);
}

/**
 * The stranded launch page's body, mapped onto the current record. `name` and
 * `phone` are read by nothing here, so neither can reach the store; the
 * record claims no consent (`whatsappOptIn: false`) and no founder answer
 * (`knowsFounder: null`) that the page never asked for.
 */
export function validateLegacyEarlyAccess(body: Record<string, unknown>): Validation {
  const fields: EarlyAccessField[] = [];
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || CONTROL.test(email) || !EMAIL.test(email)) fields.push('email');
  if (!oneOf(DEVICES, body.device)) fields.push('device');
  if (fields.length) return { ok: false, fields };
  return {
    ok: true,
    value: {
      email,
      device: body.device as EarlyAccessDevice,
      language: LEGACY_PAGE_LANGUAGE,
      pageLanguage: LEGACY_PAGE_LANGUAGE,
      knowsFounder: null,
      whatsappOptIn: false,
      phone: null,
      source: sourceOf(body.source),
      v: LEGACY_ARM,
    },
  };
}

/**
 * Every error answer carries a sentence in `error` and the machine code in
 * `code`. The stranded launch page prints `error` to the visitor verbatim
 * (its `launch.js` throws `new Error(data.error)` and shows the message),
 * including for answers produced before any body is read, so `error` must
 * always be something a person can read. The current site reads only the
 * status (`site/landing.js`). The sentences are the stranded endpoint's own.
 */
export const EARLY_ACCESS_ERRORS = {
  method_not_allowed: 'Method not allowed.',
  forbidden_origin: 'Please register from the MaybeSitter website.',
  unsupported_media_type: 'Please refresh the page and try again.',
  payload_too_large: 'The form is too large.',
  invalid_json: 'Please check your form and try again.',
  invalid_fields: 'Please check the highlighted fields.',
  rate_limited: 'Registration is busy right now. Please try again in a little while.',
  unavailable: 'We couldn’t save your place just now. Your details are still here—please try again.',
} as const;
export type EarlyAccessErrorCode = keyof typeof EARLY_ACCESS_ERRORS;

/** The legacy page reads `fields` as `{field: message}`; these are its per-field words. */
const LEGACY_FIELD_MESSAGES = {
  email: 'Please enter a valid email address.',
  device: 'Please choose iPhone or Android.',
} as const;

const respond = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });

const fail = (code: EarlyAccessErrorCode, status: number, extra: Record<string, string> = {}, more: Record<string, unknown> = {}) =>
  respond({ error: EARLY_ACCESS_ERRORS[code], code, ...more }, status, extra);

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
  if (request.method !== 'POST') return fail('method_not_allowed', 405, { Allow: 'POST' });
  if (!originAllowed(request, env)) return fail('forbidden_origin', 403);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return fail('unsupported_media_type', 415);
  }
  if (Number(request.headers.get('content-length') || 0) > EARLY_ACCESS_BODY_LIMIT_BYTES) {
    return fail('payload_too_large', 413);
  }

  let body: unknown;
  try {
    body = await boundedJson(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return fail('payload_too_large', 413);
    return fail('invalid_json', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_json', 400);
  const fields = body as Record<string, unknown>;

  // A bot filled the field people never see. Answer as if it worked, and touch nothing.
  if (fields.website !== undefined && fields.website !== '') return respond({ ok: true }, 200);

  const interest = fields.kind === 'landing_interest';
  const legacy = !interest && isLegacyShape(fields);
  const validation = interest ? validateLandingInterest(fields) : legacy ? validateLegacyEarlyAccess(fields) : validateEarlyAccess(fields);
  if (!validation.ok) {
    // The current site gets the field names as a list; the legacy page indexes `fields` by name.
    if (!legacy) return fail('invalid_fields', 422, {}, { fields: validation.fields });
    const messages = Object.fromEntries(validation.fields.map((field) => [field, LEGACY_FIELD_MESSAGES[field as 'email' | 'device']]));
    return fail('invalid_fields', 422, {}, { fields: messages });
  }

  try {
    const store = (options.storeFactory ?? productionEarlyAccessStore)();
    const now = (options.now ?? Date.now)();
    if (!(await store.allow(now, options.hourlyLimit ?? EARLY_ACCESS_HOURLY_LIMIT))) {
      return fail('rate_limited', 429, { 'Retry-After': '3600' });
    }
    // First registration wins, and the answer is the same either way, so the
    // endpoint never reveals whether an email is already on the list.
    await store.register({ ...validation.value, registeredAt: new Date(now).toISOString() });
    return respond({ ok: true }, 200);
  } catch {
    return fail('unavailable', 503, { 'Retry-After': '30' });
  }
}

/**
 * `POST /api/early-access/events`: the stranded launch page's page-view ping
 * (`{event, source}`, fire-and-forget). Main keeps no page-view counts — the
 * privacy policy says the site counts nothing — so this is a 204 that reads
 * no body and touches no store. It exists only so the page that is still live
 * gets an answer instead of a 404 after main reaches production, and it keeps
 * the sign-up's origin check so it is no more open than the form.
 */
export async function handleEarlyAccessEvent(request: Request, options: Pick<EarlyAccessOptions, 'env'> = {}): Promise<Response> {
  const env = options.env ?? process.env;
  if (request.method !== 'POST') return fail('method_not_allowed', 405, { Allow: 'POST' });
  if (!originAllowed(request, env)) return fail('forbidden_origin', 403);
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
