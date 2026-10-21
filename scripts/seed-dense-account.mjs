#!/usr/bin/env node

const API_BASE = process.env.SEED_API_BASE_URL ?? '';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const PASSWORD = process.env.SEED_ACCOUNT_PASSWORD ?? 'dense-emulator-account-only';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function emailArgument(argv) {
  const index = argv.indexOf('--email');
  return index >= 0 ? argv[index + 1] ?? '' : '';
}

let base;
try {
  base = new URL(API_BASE);
} catch {
  fail('SEED_API_BASE_URL must be a loopback URL');
}
if (!['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) {
  fail('SEED_API_BASE_URL must use a loopback host');
}
if (!AUTH_HOST || !FIRESTORE_HOST) {
  fail('FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST must both be set');
}
const email = emailArgument(process.argv.slice(2));
if (!email) fail('an explicit --email is required');

const healthUrl = new URL('/api/health/ready', base);
const health = await fetch(healthUrl);
if (health.headers.get('x-maybesitter-emulators') !== 'auth,firestore') {
  fail('server emulator attestation is missing; refusing to seed');
}
if (!health.ok) fail(`server emulator attestation failed with HTTP ${health.status}`);

console.log(`Dense seed target: ${email} at ${base.origin}`);

async function authRequest(path, body) {
  const response = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/${path}?key=fake-api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { response, parsed, text };
}

async function tokenForAccount() {
  const signup = await authRequest('accounts:signUp', { email, password: PASSWORD, returnSecureToken: true });
  if (signup.response.ok) return signup.parsed.idToken;
  if (signup.parsed?.error?.message !== 'EMAIL_EXISTS') {
    throw new Error(`auth emulator sign-up failed (${signup.response.status})`);
  }
  const signin = await authRequest('accounts:signInWithPassword', { email, password: PASSWORD, returnSecureToken: true });
  if (!signin.response.ok) throw new Error(`auth emulator sign-in failed (${signin.response.status})`);
  return signin.parsed.idToken;
}

const token = await tokenForAccount();

async function api(path, { method = 'GET', body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(`/api/mobile/${path}`, base), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  if (!response.ok) {
    const reason = typeof parsed.reason === 'string' ? ` (${parsed.reason})` : '';
    throw new Error(`${method} /api/mobile/${path} failed with HTTP ${response.status}${reason}`);
  }
  return parsed;
}

const DAY = 24 * 60 * 60_000;
const now = new Date();
const utcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const iso = (value) => new Date(value).toISOString();
const arabicTitles = [
  'اتصل بأحمد', 'راجع خطة الأسبوع', 'رتب ملفات الجامعة', 'اشتري أغراض البيت',
  'احجز موعد المدرسة', 'حضّر أسئلة الاجتماع', 'راجع المصاريف', 'امشِ نصف ساعة',
];

const commitments = [];
for (let index = 0; index < 12; index += 1) {
  commitments.push({
    title: `M6D-T${String(index + 1).padStart(2, '0')} ${arabicTitles[index % arabicTitles.length]}`,
    dueAt: utcDay + (8 + Math.floor(index / 2)) * 60 * 60_000,
    rangeHours: 2,
    outcome: null,
  });
}
for (let index = 0; index < 12; index += 1) {
  commitments.push({
    title: `M6D-N${String(index + 1).padStart(2, '0')} ${index % 2 ? 'Loaded tomorrow' : arabicTitles[index % arabicTitles.length]}`,
    dueAt: utcDay + DAY + (8 + Math.floor(index / 2)) * 60 * 60_000,
    rangeHours: index % 3 === 0 ? 2 : 0,
    outcome: null,
  });
}
for (let index = 0; index < 13; index += 1) {
  commitments.push({
    title: `M6D-F${String(index + 1).padStart(2, '0')} ${index % 2 ? 'Three weeks ahead' : arabicTitles[index % arabicTitles.length]}`,
    dueAt: utcDay + (21 + index) * DAY + 10 * 60 * 60_000,
    rangeHours: 0,
    outcome: null,
  });
}
for (let index = 0; index < 15; index += 1) {
  commitments.push({
    title: `M6D-D${String(index + 1).padStart(2, '0')} Done history`,
    dueAt: utcDay - (index + 2) * DAY + 9 * 60 * 60_000,
    rangeHours: 0,
    outcome: 'complete',
  });
}
for (let index = 0; index < 5; index += 1) {
  commitments.push({
    title: `M6D-X${String(index + 1).padStart(2, '0')} Dropped history`,
    dueAt: utcDay - (index + 20) * DAY + 11 * 60 * 60_000,
    rangeHours: 0,
    outcome: 'cancel',
  });
}
// The public action API intentionally owns settlement timestamps and stamps
// server "now". These exercise old due dates through that real API; it cannot
// manufacture a completedAt/droppedAt more than 90 days in the past.
for (let index = 0; index < 3; index += 1) {
  commitments.push({
    title: `M6D-O${String(index + 1).padStart(2, '0')} Old settled example`,
    dueAt: utcDay - (100 + index) * DAY + 12 * 60 * 60_000,
    rangeHours: 0,
    outcome: index === 2 ? 'cancel' : 'complete',
  });
}

function clockText(timestamp) {
  const value = new Date(timestamp);
  const hour = value.getUTCHours();
  const minute = value.getUTCMinutes();
  const suffix = hour >= 12 ? 'pm' : 'am';
  const twelve = hour % 12 || 12;
  return `${twelve}${minute ? `:${String(minute).padStart(2, '0')}` : ''}${suffix}`;
}

async function createCommitment(definition) {
  const referenceTime = iso(definition.dueAt - DAY);
  const start = clockText(definition.dueAt);
  const end = clockText(definition.dueAt + definition.rangeHours * 60 * 60_000);
  const text = definition.rangeHours
    ? `Dense seed item tomorrow from ${start} to ${end}`
    : `Dense seed item tomorrow at ${start}`;
  const proposal = await api('capture', {
    method: 'POST',
    body: { text, referenceTime, timezone: 'UTC', locale: 'en' },
  });
  const item = Array.isArray(proposal.items) ? proposal.items[0] : null;
  if (!proposal.proposalId || !item?.itemId) throw new Error('capture returned no commitment proposal');
  const confirmed = await api('capture/confirm', {
    method: 'POST',
    body: {
      proposalId: proposal.proposalId,
      itemIds: [item.itemId],
      edits: [{ itemId: item.itemId, title: definition.title }],
      idempotencyKey: `m6-dense:${definition.title}`,
    },
  });
  const saved = Array.isArray(confirmed.persisted) ? confirmed.persisted[0] : null;
  if (!saved?.commitmentId) throw new Error('capture confirmation persisted no commitment');
  return { id: saved.commitmentId, status: 'active' };
}

const exported = await api('account/export');
const exportedCommitments = Array.isArray(exported?.collections?.commitments)
  ? exported.collections.commitments
  : [];
const existingCommitments = new Map(exportedCommitments.flatMap((row) => {
  const data = row?.data;
  return typeof data?.title === 'string' && typeof data?.id === 'string'
    ? [[data.title, { id: data.id, status: data.status }]]
    : [];
}));

let commitmentsCreated = 0;
let commitmentsSettled = 0;
for (const definition of commitments) {
  const existing = existingCommitments.get(definition.title);
  const commitment = existing ?? await createCommitment(definition);
  if (!existing) commitmentsCreated += 1;
  if (definition.outcome && !['completed', 'dropped'].includes(commitment.status)) {
    await api(`commitments/${encodeURIComponent(commitment.id)}/actions`, {
      method: 'POST', body: { action: definition.outcome },
    });
    commitmentsSettled += 1;
  }
}

const blockDefinitions = [
  { title: 'M6D محاضرات الجامعة', weekdays: [1, 3], start: '09:00', end: '13:00' },
  { title: 'M6D Deep work', weekdays: [2, 4], start: '10:00', end: '12:00' },
  { title: 'M6D التزام عائلي', weekdays: [5], start: '17:00', end: '20:00' },
];
const listedBlocks = await api('weekly-blocks');
const blockTitles = new Set((listedBlocks.items ?? []).map((item) => item.title));
for (const block of blockDefinitions) {
  if (blockTitles.has(block.title)) continue;
  await api('weekly-blocks', {
    method: 'POST',
    body: { ...block, timezone: 'Asia/Jerusalem', confirmation: { confirmedByUserAt: now.toISOString() } },
  });
}

const habitDefinitions = [
  { title: 'M6D مشي الصبح', weekdays: [1, 3, 5], start: '07:00', end: '08:00' },
  { title: 'M6D Read in English', weekdays: [2, 4], start: '20:00', end: '21:00' },
  { title: 'M6D مراجعة الأسبوع', weekdays: [6], start: '10:00', end: '11:00' },
];
const listedHabits = await api('habits');
const habitTitles = new Set((listedHabits.items ?? []).map((item) => item.title));
for (const habit of habitDefinitions) {
  if (habitTitles.has(habit.title)) continue;
  await api('habits?timezone=Asia%2FJerusalem', {
    method: 'POST',
    body: {
      title: habit.title,
      cadence: { kind: 'weekdays', weekdays: habit.weekdays },
      durationMinutes: 30,
      preferredWindows: [{ start: habit.start, end: habit.end }],
      minimumOccurrences: 1,
      maximumOccurrences: habit.weekdays.length,
      flexibility: 'protected_flexible',
      recoveryPolicy: 'recover_within_period',
      source: 'user_created',
      confirmation: { confirmedByUserAt: now.toISOString(), sourceRef: null, acceptedSuggestedValues: false },
    },
  });
}

const goals = ['M6D إنهاء مشروع التخرج', 'M6D Improve spoken English', 'M6D أركض 10 كيلومتر'];
const facts = [
  ['ar', 'M6D بدرس هندسة برمجيات'], ['ar', 'M6D بفضّل أشتغل الصبح'],
  ['ar', 'M6D عندي محاضرات يوم الاثنين'], ['ar', 'M6D براجع خطتي كل سبت'],
  ['ar', 'M6D بحتاج وقت هادي للتركيز'], ['ar', 'M6D بحب أمشي قبل الشغل'],
  ['ar', 'M6D العيلة أولوية يوم الجمعة'], ['ar', 'M6D بستخدم المواصلات للجامعة'],
  ['en', 'M6D Studies best with short breaks'], ['en', 'M6D Prefers meetings after lunch'],
  ['en', 'M6D Uses English for work notes'], ['en', 'M6D Keeps Sundays for planning'],
];
const listedMemory = await api('memory');
const memoryContent = new Set((listedMemory.items ?? []).map((item) => item.content));
for (const content of goals) {
  if (!memoryContent.has(content)) await api('memory', { method: 'POST', body: { kind: 'goal', content, language: /[\u0600-\u06ff]/.test(content) ? 'ar' : 'en' } });
}
for (const [language, content] of facts) {
  if (!memoryContent.has(content)) await api('memory', { method: 'POST', body: { kind: 'fact', content, language } });
}

const ideas = ['M6D جرّب دورة تصوير', 'M6D Weekend hiking trip', 'M6D اعمل زاوية قراءة', 'M6D Learn basic Spanish'];
const listedSeeds = await api('seeds');
const seedSummaries = new Set((listedSeeds.items ?? []).map((item) => item.summary));
for (const summary of ideas) {
  if (seedSummaries.has(summary)) continue;
  await api('seeds', { method: 'POST', body: { kind: 'idea', summary, idempotencyKey: `m6-dense:${summary}` } });
}

const football = await api('football');
const followed = new Set(Array.isArray(football.followedClubIds) ? football.followedClubIds : []);
followed.add('barcelona');
await api('football', { method: 'PUT', body: { clubIds: [...followed], locale: 'ar' } });

console.log(JSON.stringify({
  success: true,
  commitments: commitments.length,
  commitmentsCreated,
  commitmentsSettled,
  weeklyBlocks: blockDefinitions.length,
  goals: goals.length,
  habits: habitDefinitions.length,
  ideas: ideas.length,
  memoryFacts: facts.length,
  followedClub: 'barcelona',
}));
