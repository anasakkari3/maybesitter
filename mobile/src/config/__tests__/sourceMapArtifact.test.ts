import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The Hermes source map has to actually be produced (UC-4.4, #180).
 *
 * `scripts/export-sourcemap.sh` and `buildArtifactPaths` both existed from the
 * day #180 landed, and nothing ran the script. The map was never written, the
 * artifact directory was collected empty, and "a JS error maps to `src/` names"
 * was a criterion no build could meet — a whole feature held together by a
 * file nobody invoked.
 *
 * That failure is invisible: every command passes, the build succeeds, and the
 * only symptom is a stack of offsets months later. So the wiring is asserted
 * here rather than trusted, and the three ways it can silently come apart —
 * the hook removed, the hook misnamed, the output path drifting away from the
 * collected path — each fail this file.
 */

const ROOT = join(__dirname, '..', '..', '..');

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const easJson = JSON.parse(readFileSync(join(ROOT, 'eas.json'), 'utf8')) as {
  build: Record<string, { developmentClient?: boolean; buildArtifactPaths?: string[] }>;
};
const script = readFileSync(join(ROOT, 'scripts', 'export-sourcemap.sh'), 'utf8');

/**
 * The npm scripts EAS Build runs by name, from
 * https://docs.expo.dev/build-reference/npm-hooks/.
 *
 * Listed so a typo fails here rather than in a build log nobody reads:
 * `eas-build-post-success` is not a hook, and a package.json script by that
 * name would simply never run.
 */
const EAS_BUILD_HOOKS = [
  'eas-build-pre-install',
  'eas-build-post-install',
  'eas-build-on-success',
  'eas-build-on-error',
  'eas-build-on-complete',
  'eas-build-on-cancel',
] as const;

/** The directory the script writes into, read out of the script itself. */
function outputDirectory(): string {
  const match = /mkdir -p (\S+)/.exec(script);
  expect(match).not.toBeNull();
  return match![1]!;
}

/** The profiles that embed a JS bundle, so a map for them means something. */
function releaseProfiles(): string[] {
  return Object.entries(easJson.build)
    .filter(([, profile]) => profile.developmentClient !== true)
    .map(([name]) => name);
}

describe('the source map is produced by the build, not by hand', () => {
  it('runs the export script from a hook EAS actually invokes', () => {
    const hooks = Object.keys(packageJson.scripts).filter(name =>
      (EAS_BUILD_HOOKS as readonly string[]).includes(name),
    );
    // On success rather than post-install: the map must describe the bundle
    // this build embedded, which does not exist until the build has run.
    expect(hooks).toContain('eas-build-on-success');
    expect(packageJson.scripts['eas-build-on-success']).toContain('scripts/export-sourcemap.sh');
  });

  it('writes where eas.json collects, on every profile that embeds a bundle', () => {
    const directory = outputDirectory();
    expect(directory).toBe('build/sourcemaps');
    const profiles = releaseProfiles();
    // Staging and production both, and neither by accident: staging is what a
    // closed tester installs, and its crashes are the ones the crash-free
    // sessions number is measured on.
    expect(profiles.sort()).toEqual(['production', 'staging']);
    for (const name of profiles) {
      const paths = easJson.build[name]?.buildArtifactPaths ?? [];
      expect(`${name}:${paths.some(path => path.startsWith(`${directory}/`))}`).toBe(`${name}:true`);
    }
  });

  it('does not export a map for a development client, which embeds no bundle', () => {
    // A map for a bundle the binary does not contain symbolicates to the wrong
    // lines, which is worse than none because it looks like an answer.
    expect(script).toMatch(/EAS_BUILD_PROFILE:-.*=\s*"development"/);
    expect(easJson.build.development?.buildArtifactPaths).toBeUndefined();
  });

  it('exports the production bundle, not a development one', () => {
    // `--dev false`, or the map describes a bundle nobody shipped.
    expect(script).toContain('--dev false');
    expect(script).toContain('--sourcemap-output');
  });
});
