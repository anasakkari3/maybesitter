import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { loadAll, YAMLException } from 'js-yaml';

/**
 * The Maestro flows, checked here rather than on a device (UC-4.2, #177).
 *
 * A flow file is only ever executed by `maestro test` against an installed
 * build — which needs a simulator, a build, and a person watching. So every
 * mistake in one of these files has, until now, been found at the far end of
 * that loop: a typo'd key, an `appId` that no longer matches the bundle, or —
 * the common one — a `testID` that was renamed in a component months ago and
 * left behind in a flow nobody had run since.
 *
 * None of those need a device to catch. This is the cheap half.
 *
 * What it cannot check is behaviour: that the flow's *sequence* makes sense,
 * that the element it taps is the one a person would tap, that the app really
 * reaches that screen. Those still need `maestro test`, and the DEVICE
 * follow-up issue is where that lives.
 */

const MOBILE_ROOT = join(__dirname, '..', '..', '..');
const FLOW_DIR = join(MOBILE_ROOT, '.maestro');
const SRC_DIR = join(MOBILE_ROOT, 'src');

const flowFiles = readdirSync(FLOW_DIR)
  .filter(name => name.endsWith('.yaml') || name.endsWith('.yml'))
  .sort();

/** Every `.ts`/`.tsx` a person writes, excluding test and mock files. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__' || entry === '__mocks__' || entry === '__fixtures__') continue;
      sourceFiles(path, found);
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Every `testID` the app can render, as a pattern.
 *
 * Matches `testID="x"`, `testID={'x'}` and the object-literal `testID: 'x'`
 * that `SettingsScreen`'s rows use. A template literal becomes a pattern
 * rather than a string: `testID={`today-item-${id}`}` can produce any
 * `today-item-…`, and `testID={`${testID ?? 'toggle'}-busy`}` in `ServerToggle`
 * can produce `trust-analytics-busy` — an id that appears nowhere in the
 * repository as a literal, and which a plain substring search would call
 * missing.
 *
 * ── The patterns that have to be thrown away ─────────────────────
 *
 * `RowActions` renders `testID={`${testID}-${action.name}`}`, which is *both*
 * halves dynamic: as a pattern that is `^.*-.*$`, and it matches every
 * hyphenated id there has ever been. Left in, it makes this whole file pass
 * for anything — which is how this was found: renaming `trust-knows` in
 * `TrustScreen` did not turn the check red. A pattern whose longest fixed
 * piece is shorter than `MIN_LITERAL` is not evidence that an id exists, so it
 * is discarded, and the ids it would have covered are matched by the literal
 * at the call site instead.
 */
const MIN_LITERAL = 4;

function renderableTestIdPatterns(): { source: string; pattern: RegExp }[] {
  const patterns: { source: string; pattern: RegExp }[] = [];
  // `[A-Za-z]*[Tt]estID` rather than `testID`: a component that forwards an
  // id to a child names the prop for the child — `actionTestID` on `Notice`
  // becomes `testID` on the link inside it. The capital T made the narrower
  // pattern miss a real, renderable id, which is the one thing this guard
  // must not do.
  const declaration = /\b[A-Za-z]*[Tt]estID\s*[=:]\s*\{?\s*(['"`])([\s\S]*?)\1/g;
  for (const file of sourceFiles(SRC_DIR)) {
    const code = readFileSync(file, 'utf8');
    for (const match of code.matchAll(declaration)) {
      const raw = match[2] ?? '';
      // `${…}` is anything; everything else has to match exactly.
      const literals = raw.split(/\$\{[\s\S]*?\}/);
      if (Math.max(...literals.map(part => part.length)) < MIN_LITERAL) continue;
      const body = literals.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      patterns.push({ source: raw, pattern: new RegExp(`^${body}$`) });
    }
  }
  return patterns;
}

/**
 * Every localised string, for the one thing the patterns above cannot cover.
 *
 * `onboarding.yaml` matches a row by its Arabic label rather than by a
 * `testID`, which Maestro's `id` allows. That is weaker — a label is copy and
 * copy gets reworded — but it is a real and working match, so it is accepted
 * here rather than pretending the flow is broken.
 */
function localisedStrings(): Set<string> {
  const values = new Set<string>();
  const localeDir = join(SRC_DIR, 'i18n', 'locales');
  for (const name of readdirSync(localeDir).filter(file => file.endsWith('.json'))) {
    const table = JSON.parse(readFileSync(join(localeDir, name), 'utf8')) as Record<string, unknown>;
    for (const value of Object.values(table)) if (typeof value === 'string') values.add(value);
  }
  return values;
}


/** The header document and the command list, as plain values. */
function documentsOf(file: string): unknown[] {
  return loadAll(readFileSync(join(FLOW_DIR, file), 'utf8')) as unknown[];
}

/** The YAML parse error for a flow, or '' when it parses. */
function parseError(file: string): string {
  try {
    documentsOf(file);
    return '';
  } catch (error) {
    return error instanceof YAMLException ? error.message : String(error);
  }
}

/** Every `id:` a flow selects on, wherever it is nested. */
function referencedIds(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) referencedIds(item, found);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'id' && typeof value === 'string') found.push(value);
      else referencedIds(value, found);
    }
  }
  return found;
}

/**
 * The bundle identifier, taken from the two files that set it rather than
 * written here — a constant in this test would go stale with them.
 */
function bundleIdentifier(): string {
  const appJson = JSON.parse(readFileSync(join(MOBILE_ROOT, 'app.json'), 'utf8')) as {
    expo: { ios: { bundleIdentifier: string }; android: { package: string } };
  };
  const fromConfig = /bundleIdentifier:\s*'([^']+)'/.exec(readFileSync(join(MOBILE_ROOT, 'app.config.ts'), 'utf8'));
  expect(fromConfig).not.toBeNull();
  // `app.config.ts` wins at build time, so a flow matching only `app.json`
  // would target an app that is never installed.
  const declared = fromConfig![1] ?? '';
  expect(declared).toBe(appJson.expo.ios.bundleIdentifier);
  expect(appJson.expo.android.package).toBe(appJson.expo.ios.bundleIdentifier);
  return declared;
}

const BUNDLE_ID = bundleIdentifier();
const PATTERNS = renderableTestIdPatterns();
const STRINGS = localisedStrings();

describe('.maestro flows', () => {
  it('finds the flows at all', () => {
    // A rename of the directory would otherwise turn every case below into a
    // vacuous pass.
    expect(flowFiles.length).toBeGreaterThanOrEqual(9);
    expect(flowFiles).toContain('legal-links.yaml');
  });

  it.each(flowFiles)('%s is two valid YAML documents', file => {
    // The parse error itself is the message, so a bad file says which line.
    expect(`${file}:${parseError(file)}`).toBe(`${file}:`);
    // A Maestro file is a header document, `---`, then the commands.
    const documents = documentsOf(file);
    expect(documents).toHaveLength(2);
    expect(Array.isArray(documents[1])).toBe(true);
  });

  it.each(flowFiles)('%s targets the app this repository builds', file => {
    const { appId, name } = documentsOf(file)[0] as { appId?: string; name?: string };
    expect(`${file}:${appId}`).toBe(`${file}:${BUNDLE_ID}`);
    expect(typeof name).toBe('string');
  });

  /**
   * The one that earns its keep.
   *
   * A renamed `testID` leaves a flow that still parses, still has the right
   * `appId`, and fails only when somebody runs it on a device — by which point
   * the rename is weeks old. This fails in CI on the commit that renames it.
   */
  it.each(flowFiles)('%s only selects on ids the app can render', file => {
    const ids = referencedIds(documentsOf(file)[1]);
    const missing = ids.filter(id => {
      // A flow may select on a regex; `today-item-.*` stands for some real id.
      const probe = id.replace(/\.\*/g, 'ANY');
      return !PATTERNS.some(({ pattern }) => pattern.test(probe)) && !STRINGS.has(id);
    });
    expect(`${file}:${[...new Set(missing)].sort().join(',')}`).toBe(`${file}:`);
  });

  /**
   * The guard on the guard.
   *
   * The first version of the case above passed with `trust-knows` renamed in
   * `TrustScreen`, because one `${a}-${b}` template had widened the pattern set
   * to "anything with a hyphen in it". A check that cannot say no is not a
   * check, so this says no to ids that look exactly like real ones.
   *
   * What it deliberately does not probe: an id under a prefix the app really
   * does complete at runtime. `NextStepCard` renders
   * `testID={`next-step-${decision}`}`, so *any* `next-step-…` is genuinely
   * renderable and a rename from `next-step-accept` to `next-step-accepted`
   * cannot be caught here. That is a real limit of reading source instead of
   * running the app, and it is a device run's job, not a pretend assertion's.
   */
  it.each([
    'trust-knows-v2',
    'settingz-trust',
    'today-tem-3',
    'definitely-not-a-real-id',
  ])('rejects %s, which nothing renders', id => {
    expect(PATTERNS.some(({ pattern }) => pattern.test(id))).toBe(false);
    expect(STRINGS.has(id)).toBe(false);
  });

  it('reads real testIDs out of the app, not an empty list', () => {
    // If the scan ever stops matching — a refactor to a helper, a prop rename —
    // every case above passes for the wrong reason.
    expect(PATTERNS.length).toBeGreaterThan(50);
    expect(PATTERNS.map(entry => entry.source)).toContain('settings-trust');
    expect(PATTERNS.some(({ pattern }) => pattern.test('trust-analytics-busy'))).toBe(true);
  });
});
