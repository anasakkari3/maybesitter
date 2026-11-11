#!/usr/bin/env node
/**
 * Grant store entitlements to one account on the local Firestore emulator,
 * so a simulator run can show what a paying user sees (lib/features).
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *     node scripts/dev-grant-features.mjs --uid <uid> --grants gmail_full,base [--days 30]
 *   ... --grants none   # remove every grant
 *
 * Emulator only, by construction: it refuses without FIRESTORE_EMULATOR_HOST
 * on a loopback host, and it talks to the emulator's REST API with the
 * emulator-only `Bearer owner` token, which a real project rejects. In
 * production the projection is written by the server from the store, never
 * by a script.
 */
const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-maybesitter';
const GRANTS = ['base', 'gmail_light', 'gmail_full', 'meeting_prep', 'goal_plans', 'memory_plus'];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? '' : '';
}

if (!HOST) fail('FIRESTORE_EMULATOR_HOST must be set: this script writes to the local emulator only');
const hostname = HOST.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) fail('FIRESTORE_EMULATOR_HOST must be a loopback host');
if (!PROJECT.startsWith('demo-')) fail('GCLOUD_PROJECT must be a demo- project for the emulator');

const uid = argument('uid');
if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) fail('an explicit --uid is required');
const raw = argument('grants');
const grants = raw === 'none' ? [] : raw.split(',').map((value) => value.trim()).filter(Boolean);
if (raw !== 'none' && grants.length === 0) fail(`--grants takes a comma list of ${GRANTS.join(', ')}, or none`);
const unknown = grants.filter((grant) => !GRANTS.includes(grant));
if (unknown.length > 0) fail(`unknown grant(s): ${unknown.join(', ')}`);
const days = Number.parseInt(argument('days') || '30', 10);
if (!Number.isFinite(days) || days < 1 || days > 366) fail('--days must be 1–366');

const now = new Date();
const expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();
const string = (value) => ({ stringValue: value });
const entitlements = grants.map((entitlementId) => ({
  mapValue: { fields: {
    entitlementId: string(entitlementId),
    status: string('active'),
    expiresAt: string(expiresAt),
    willRenew: { booleanValue: true },
  } },
}));
const document = { fields: {
  v: { integerValue: '1' },
  updatedAt: string(now.toISOString()),
  projection: { mapValue: { fields: {
    provider: string('revenuecat'),
    scopeId: string(uid),
    fetchedAt: string(now.toISOString()),
    entitlements: { arrayValue: { values: entitlements } },
  } } },
} };

const url = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}/features/entitlements`;
const response = await fetch(url, {
  method: 'PATCH',
  headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
  body: JSON.stringify(document),
});
if (!response.ok) fail(`emulator write failed (${response.status})`);
console.log(`granted [${grants.join(', ') || 'none'}] to ${uid} until ${expiresAt} on ${HOST}`);
