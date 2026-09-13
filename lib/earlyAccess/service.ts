import { createHash } from 'node:crypto';
import { getStorage, resolveStorageBackend, type StorageAdapter } from '../storage';

export interface Registration { name: string; email: string; device: 'iphone' | 'android'; phone: string | null; source: string; registeredAt: string; }
export interface AccessStore {
  register(value: Registration): Promise<boolean>;
  allow(key: string, now: number, limit: number): Promise<boolean>;
  event(name: string, source: string, day: string): Promise<void>;
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function createAccessStore(storage: StorageAdapter): AccessStore {
  return {
    register: (value) => storage.runTransaction(async tx => {
      const path = `earlyAccessRegistrations/${digest(value.email)}`;
      if (await tx.get(path)) return false;
      tx.create(path, value);
      return true;
    }),
    allow: (key, now, limit) => storage.runTransaction(async tx => {
      const path = `earlyAccessRateLimits/${digest(key)}`;
      const existing = await tx.get<{ count: number; resetsAt: number }>(path);
      const current = existing && existing.resetsAt > now ? existing : { count: 0, resetsAt: now + 3600000 };
      if (current.count >= limit) return false;
      tx.set(path, { count: current.count + 1, resetsAt: current.resetsAt, expiresAt: new Date(now + 86400000) });
      return true;
    }),
    event: (name, source, day) => storage.runTransaction(async tx => {
      const path = `earlyAccessMetrics/${digest(`${day}:${source}:${name}`)}`;
      const row = await tx.get<{ count: number }>(path);
      tx.set(path, { day, source, event: name, count: (row?.count ?? 0) + 1 });
    }),
  };
}
export function productionAccessStore(): AccessStore {
  // Never acknowledge a signup into the normal developer/test memory store.
  if (resolveStorageBackend() !== 'firestore') throw new Error('Early access requires durable Firestore storage');
  return createAccessStore(getStorage());
}
export function sourceOf(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value.toLowerCase() : 'direct';
}
export function validateRegistration(body: Record<string, unknown>) {
  const errors: Record<string, string> = {};
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!name || name.length > 80 || new RegExp('[\\p{Cc}\\p{Cf}<>]', 'u').test(name)) errors.name = 'Please enter your first name.';
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) errors.email = 'Please enter a valid email address.';
  if (body.device !== 'iphone' && body.device !== 'android') errors.device = 'Please choose iPhone or Android.';
  if (phone && (!/^\+?[\d\s().-]{7,30}$/.test(phone) || phone.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length > 15)) errors.phone = 'Please enter a valid phone number, or leave it blank.';
  return { errors, value: { name, email, device: body.device as Registration['device'], phone: phone || null, source: sourceOf(body.source) } };
}
const response = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body');
  const decoder = new TextDecoder(); let length = 0; let text = '';
  try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 4096) { await reader.cancel(); throw new Error('size'); } text += decoder.decode(part.value, { stream: true }); } }
  finally { reader.releaseLock(); }
  const body = JSON.parse(text + decoder.decode());
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body');
  return body;
}
export async function handleEarlyAccess(request: Request, storeFactory = productionAccessStore): Promise<Response> {
  if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
  const origin = request.headers.get('origin');
  const configured = (process.env.MAYBESITTER_SITE_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  const local = process.env.NODE_ENV !== 'production' && !process.env.K_SERVICE;
  const sameOrigin = origin === new URL(request.url).origin;
  if (!origin || (!configured.includes(origin) && !(local && sameOrigin)) || request.headers.get('sec-fetch-site') === 'cross-site') return response({ error: 'Please register from the MaybeSitter website.' }, 403);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return response({ error: 'Please refresh the page and try again.' }, 415);
  if (Number(request.headers.get('content-length') || 0) > 4096) return response({ error: 'The form is too large.' }, 413);
  let body;
  try { body = await boundedJson(request); } catch { return response({ error: 'Please check your form and try again.' }, 400); }
  if (body.website) return response({ ok: true });
  const isMetric = new URL(request.url).pathname.endsWith('/events');
  const { errors, value } = validateRegistration(body);
  const events = ['page_view', 'early_access_click', 'registration_started'];
  if (isMetric && !events.includes(String(body.event))) return response({ error: 'Unknown event.' }, 400);
  if (!isMetric && Object.keys(errors).length) return response({ error: 'Please check the highlighted fields.', fields: errors }, 422);
  try {
    const store = storeFactory(); const now = Date.now(); const day = new Date(now).toISOString().slice(0, 10);
    // Global cap is independent of client-supplied forwarding headers. No IPs or cookies are stored.
    if (!(await store.allow(isMetric ? 'metrics' : 'registrations', now, isMetric ? 10000 : 1000))) return response({ error: 'Registration is busy right now. Please try again in a little while.' }, 429, { 'Retry-After': '3600' });
    if (isMetric) { await store.event(String(body.event), sourceOf(body.source), day); return response({ ok: true }); }
    const created = await store.register({ ...value, registeredAt: new Date(now).toISOString() });
    // A metrics outage must not turn an already persisted registration into a failure.
    if (created) await store.event('registration_succeeded', value.source, day).catch(() => undefined);
    // Identical response for new and existing emails prevents enumeration and unsafe overwrites.
    return response({ ok: true });
  } catch { return response({ error: 'We couldn’t save your place just now. Your details are still here—please try again.' }, 503, { 'Retry-After': '30' }); }
}
