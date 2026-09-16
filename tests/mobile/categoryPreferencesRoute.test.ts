/**
 * Which categories this account uses, and whether its lists are split (#415).
 *
 * The defining case is the first one: an account that has never opened the
 * screen reads back `grouping: false` and the whole catalog. That is the
 * promise the feature was accepted on — the ordinary user's app does not
 * change — and it is a property of what an *absent* record reads as, not of
 * anything the client remembers to send.
 *
 * Two directions, two rules about unknown category names, and the asymmetry is
 * deliberate:
 *
 *  - **Reading storage**, an unknown name is *filtered*. A record written
 *    before a category was retired must still produce a usable preference
 *    rather than an error on a screen the user did not come to fix.
 *  - **Writing from a request**, an unknown name is *refused*. A live client
 *    sending a name the server does not have is a bug, and silently dropping
 *    it would leave the settings screen showing a category the server is not
 *    storing — the user would turn it on, see it stick, and find it gone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import {
  GET as categoriesGet,
  PUT as categoriesPut,
} from '../../src/app/api/mobile/settings/categories/route.ts';
import { COMMITMENT_CATEGORIES } from '../../src/contracts/v1/categoryContracts.ts';
import { readCategoryPreferences } from '../../lib/services/categories/categoryPreferences.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('CategoryPreferencesUser');

let auth: FakeAuthControls | null = null;

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

function get(uid = USER): Request {
  return new Request(`${BASE}/api/mobile/settings/categories`, {
    headers: { authorization: `Bearer ${tokenFor(uid)}` },
  });
}

function put(body: unknown, uid = USER): Request {
  return new Request(`${BASE}/api/mobile/settings/categories`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tokenFor(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test('an account that has never chosen sees one list and the whole catalog available', async () => {
  const teardown = setup();
  try {
    const response = await categoriesGet(get());
    assert.equal(response.status, 200);
    const body = (await json(response)) as {
      categoryPreferences: { enabled: string[]; grouping: boolean };
    };
    assert.equal(body.categoryPreferences.grouping, false);
    assert.deepEqual(body.categoryPreferences.enabled, [...COMMITMENT_CATEGORIES]);
  } finally {
    teardown();
  }
});

test('the categories a user keeps are stored and read back', async () => {
  const teardown = setup();
  try {
    const response = await categoriesPut(put({ enabled: ['work', 'family'], grouping: true }));
    assert.equal(response.status, 200);

    const stored = await readCategoryPreferences(USER);
    assert.deepEqual([...stored.enabled], ['work', 'family']);
    assert.equal(stored.grouping, true);
  } finally {
    teardown();
  }
});

test('turning the split off leaves the chosen categories alone', async () => {
  const teardown = setup();
  try {
    await categoriesPut(put({ enabled: ['work'], grouping: true }));
    await categoriesPut(put({ enabled: ['work'], grouping: false }));

    const stored = await readCategoryPreferences(USER);
    assert.deepEqual([...stored.enabled], ['work']);
    assert.equal(stored.grouping, false);
  } finally {
    teardown();
  }
});

test('a category name the server does not have is refused, not quietly dropped', async () => {
  const teardown = setup();
  try {
    const response = await categoriesPut(put({ enabled: ['work', 'hobbies'], grouping: true }));
    assert.equal(response.status, 400);

    const stored = await readCategoryPreferences(USER);
    assert.deepEqual([...stored.enabled], [...COMMITMENT_CATEGORIES], 'the refused write changed nothing');
  } finally {
    teardown();
  }
});

test('a request with no enabled list is refused', async () => {
  const teardown = setup();
  try {
    assert.equal((await categoriesPut(put({ grouping: true }))).status, 400);
    assert.equal((await categoriesPut(put({ enabled: 'work', grouping: true }))).status, 400);
  } finally {
    teardown();
  }
});

test('a user may turn every category off', async () => {
  const teardown = setup();
  try {
    const response = await categoriesPut(put({ enabled: [], grouping: true }));
    assert.equal(response.status, 200);

    const stored = await readCategoryPreferences(USER);
    assert.deepEqual([...stored.enabled], []);
  } finally {
    teardown();
  }
});

test('saving categories does not clobber the rest of the user document', async () => {
  const teardown = setup();
  try {
    await getStorage().set(userDoc(USER), { locale: 'ar', trust: { level: 'high' } });

    await categoriesPut(put({ enabled: ['health'], grouping: true }));

    const user = await getStorage().get<Record<string, unknown>>(userDoc(USER));
    assert.equal(user?.locale, 'ar');
    assert.deepEqual(user?.trust, { level: 'high' });
  } finally {
    teardown();
  }
});

test('a stored record naming a category the catalog no longer has still reads', async () => {
  const teardown = setup();
  try {
    await getStorage().set(userDoc(USER), {
      categoryPreferences: { enabled: ['work', 'hobbies'], grouping: true },
    });

    const stored = await readCategoryPreferences(USER);
    assert.deepEqual([...stored.enabled], ['work']);
    assert.equal(stored.grouping, true);
  } finally {
    teardown();
  }
});

test('an unreadable stored record reads as the ordinary one-list app', async () => {
  const teardown = setup();
  try {
    await getStorage().set(userDoc(USER), { categoryPreferences: 'yes please' });

    const stored = await readCategoryPreferences(USER);
    assert.equal(stored.grouping, false);
    assert.deepEqual([...stored.enabled], [...COMMITMENT_CATEGORIES]);
  } finally {
    teardown();
  }
});

test('the route needs a signed-in user', async () => {
  const teardown = setup();
  try {
    const anonymous = new Request(`${BASE}/api/mobile/settings/categories`);
    assert.equal((await categoriesGet(anonymous)).status, 401);
  } finally {
    teardown();
  }
});
