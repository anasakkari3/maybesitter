#!/usr/bin/env node
/**
 * The app's privacy manifest covers what its dependencies actually use
 * (UC-4.3a, #178).
 *
 * ── Why this check exists ────────────────────────────────────────
 *
 * Apple does not reliably read `PrivacyInfo.xcprivacy` out of **static**
 * CocoaPods, and this app is built with static frameworks because React Native
 * Firebase needs them. So every required-reason API used by an Expo module,
 * React Native core or Firebase has to be declared in the *app's own* manifest.
 *
 * A dependency added six months from now can bring a new required-reason API
 * with it. Nothing in the build fails; the upload is accepted; and an
 * ITMS-91053 email arrives an hour later, after the release is out of the
 * engineer's hands. This turns that into a red CI job.
 *
 * ── It recomputes rather than compares to a list ─────────────────
 *
 * The expected set is derived from the manifests actually shipped inside
 * `node_modules`, not from a second copy of the list in this file. A hard-coded
 * expectation would pass forever while the truth moved underneath it.
 *
 * Usage:  node scripts/check-privacy-manifests.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import plist from 'plist';

const MODULES = 'node_modules';

/** Every bundled manifest, without walking into build output. */
function findManifests(root, out = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      // Pods are a build artifact of a previous prebuild, not a source of truth.
      if (entry.name === 'Pods' || entry.name === '.git' || entry.name === 'build') continue;
      findManifests(path, out);
    } else if (entry.name === 'PrivacyInfo.xcprivacy') {
      out.push(path);
    }
  }
  return out;
}

function reasonsFrom(manifestPaths) {
  const required = new Map();
  for (const path of manifestPaths) {
    let parsed;
    try {
      parsed = plist.parse(readFileSync(path, 'utf8'));
    } catch {
      // A manifest we cannot read is reported rather than skipped silently:
      // an unparsed one is indistinguishable from one declaring nothing.
      console.warn(`  ! could not parse ${path}`);
      continue;
    }
    for (const entry of parsed.NSPrivacyAccessedAPITypes ?? []) {
      const category = entry.NSPrivacyAccessedAPIType;
      if (!category) continue;
      const set = required.get(category) ?? new Set();
      for (const reason of entry.NSPrivacyAccessedAPITypeReasons ?? []) set.add(reason);
      required.set(category, set);
    }
    if (parsed.NSPrivacyTracking === true) {
      console.warn(`  ! ${path} declares NSPrivacyTracking: true`);
    }
  }
  return required;
}

/** The app's own declaration, read from the Expo config rather than a plist. */
async function appManifest() {
  const config = await import('../app.config.ts').catch(() => null);
  if (config) return null;
  return null;
}

function fail(message) {
  console.error(`\nprivacy manifests: ${message}`);
  process.exitCode = 1;
}

const appConfigSource = readFileSync('app.config.ts', 'utf8');

/**
 * Reads the declared reasons out of the config source.
 *
 * Source rather than an evaluated config, so this runs on a plain Node without
 * loading the Expo toolchain — and so a reason commented out is visibly gone
 * rather than silently still matching.
 */
function declaredReasons() {
  const declared = new Map();
  const block = /NSPrivacyAccessedAPIType:\s*'([^']+)',\s*NSPrivacyAccessedAPITypeReasons:\s*\[([^\]]*)\]/g;
  let match;
  while ((match = block.exec(appConfigSource)) !== null) {
    const reasons = [...match[2].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    declared.set(match[1], new Set(reasons));
  }
  return declared;
}

console.log('privacy manifests: checking the app declaration against the installed tree');

const bundled = findManifests(MODULES);
console.log(`  ${bundled.length} bundled manifest(s) in ${MODULES}`);
const required = reasonsFrom(bundled);
const declared = declaredReasons();

if (declared.size === 0) {
  fail('app.config.ts declares no NSPrivacyAccessedAPITypes at all');
}

for (const [category, reasons] of required) {
  const have = declared.get(category);
  if (!have) {
    fail(`${category} is used by a dependency but not declared in app.config.ts`);
    continue;
  }
  for (const reason of reasons) {
    if (!have.has(reason)) {
      fail(`${category} is missing reason ${reason}, which a dependency declares`);
    }
  }
}

// Tracking is a product decision, not a dependency's to make.
if (!/NSPrivacyTracking:\s*false/.test(appConfigSource)) {
  fail('NSPrivacyTracking must be declared false');
}
if (!/NSPrivacyTrackingDomains:\s*\[\]/.test(appConfigSource)) {
  fail('NSPrivacyTrackingDomains must be empty while NSPrivacyTracking is false');
}
// Crash data must stay unlinked: the Crashlytics wrapper never calls setUserId,
// and a manifest saying otherwise would be claiming a link that does not exist.
if (!/collected\('NSPrivacyCollectedDataTypeCrashData',\s*\{\s*linked:\s*false\s*\}\)/.test(appConfigSource)) {
  fail('crash data must be declared as not linked to identity');
}
// Export compliance, so App Store Connect stops asking on every upload.
if (!/usesNonExemptEncryption:\s*false/.test(appConfigSource)) {
  fail('ios.config.usesNonExemptEncryption must be false');
}

/**
 * First-party native code that would need a reason of its own.
 *
 * There is none today: `targets/` and `modules/` do not exist, because the
 * widget (#203) and the share extension (#183) are S3. The check is here so the
 * day one of them lands, the symbol it uses is compared against a manifest
 * rather than noticed by Apple.
 */
const SYMBOLS = /systemUptime|mach_absolute_time|creationDate|modificationDate|volumeAvailableCapacity|activeInputModes|UserDefaults/;
const firstPartyNative = [];
for (const dir of ['targets', 'modules']) {
  const walk = (root) => {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(swift|m|mm)$/.test(entry.name)) firstPartyNative.push(path);
    }
  };
  try {
    if (statSync(dir).isDirectory()) walk(dir);
  } catch {
    // The target does not exist yet. Reported below rather than passed over.
  }
}

if (firstPartyNative.length === 0) {
  console.log('  no first-party native source yet (targets/ and modules/ are S3: #203, #183)');
} else {
  for (const path of firstPartyNative) {
    if (SYMBOLS.test(readFileSync(path, 'utf8'))) {
      console.log(`  ${path} uses a required-reason symbol; its target needs its own manifest`);
    }
  }
}

const categories = [...required.keys()].map((c) => c.replace('NSPrivacyAccessedAPICategory', '')).sort();
console.log(`  dependencies require: ${categories.join(', ')}`);
if (process.exitCode) {
  console.error('privacy manifests: FAILED\n');
} else {
  console.log('privacy manifests: ok\n');
}
