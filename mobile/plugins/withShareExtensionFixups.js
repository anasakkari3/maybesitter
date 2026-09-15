const fs = require('node:fs');
const path = require('node:path');
const { withEntitlementsPlist, withXcodeProject } = require('@expo/config-plugins');

/**
 * The two things `expo-share-intent` gets wrong for this app (UC-3.0, #183).
 *
 * Both are corrections *to the plugin's output*, so both have to run after it,
 * and both were found by reading `expo prebuild`'s generated `ios/` rather than
 * `expo config --type introspect` — which shows neither.
 *
 * ── Registration order is the reverse of what it looks like ──────
 *
 * This must be listed *before* `expo-share-intent` in `app.config.ts`'s
 * `plugins`.
 *
 * `withMod` (`@expo/config-plugins/build/plugins/withMod.js`) wraps whatever mod
 * is already registered for a given key and passes the previous one down as
 * `nextMod`; the wrapper runs `nextMod` and then its own action. So the plugin
 * registered **last** runs **first**, and `plugins` is applied in array order —
 * listing this one first is therefore the only position from which it can see
 * what `expo-share-intent` produced.
 *
 * That is not taken on faith. `app.config.ts` declares the App Group once and
 * the dependency prepends it again, so a generated entitlements file with one
 * entry is proof this ran second; a file with two would be proof it did not.
 * `src/config/__tests__/appConfig.test.ts` asserts both the array order and the
 * single entry.
 */

const APP_GROUPS = 'com.apple.security.application-groups';

/**
 * One app group, listed once.
 *
 * `app.config.ts` declares `group.com.maybesitter.app` under `ios.entitlements`
 * for the home-screen widget (#203), and `expo-share-intent`'s own plugin
 * *prepends* the group it needs to whatever is already there
 * (`plugin/build/ios/withIosAppEntitlements.js`). Both name the same group, so
 * without this the generated `MaybeSitter.entitlements` lists it twice.
 *
 * A duplicate is not fatal to a build, but it is a lie in a signed file: the
 * entitlements plist is what EAS syncs to the App ID's capabilities, and an
 * array with the same value twice is fine until the day a tool reads it as two
 * groups. Neither declaration is the one to remove — dropping ours would make
 * the widget's group depend on a share plugin, and dropping the dependency's
 * would mean patching a dependency — so the array is normalised afterwards,
 * preserving first-seen order.
 */
function withDedupedAppGroups(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    const groups = modConfig.modResults[APP_GROUPS];
    if (!Array.isArray(groups)) return modConfig;
    const seen = new Set();
    modConfig.modResults[APP_GROUPS] = groups.filter((group) => {
      if (typeof group !== 'string' || seen.has(group)) return false;
      seen.add(group);
      return true;
    });
    return modConfig;
  });
}

/** Rewrites one of the extension's generated files, or says which mod has not run. */
function rewrite(directory, fileName, edit) {
  const file = path.join(directory, fileName);
  // Absent means the dependency's mod has not run, which is the ordering
  // mistake this file's header is about. Loud, because every failure it would
  // otherwise cause is silent.
  if (!fs.existsSync(file)) {
    throw new Error(
      `withShareExtensionFixups: ${file} was not written. List this plugin before expo-share-intent.`,
    );
  }
  const before = fs.readFileSync(file, 'utf8');
  const after = edit(before);
  if (after === before) throw new Error(`withShareExtensionFixups: nothing to change in ${file}`);
  fs.writeFileSync(file, after);
}

/**
 * The extension's own two generated files, corrected.
 *
 * Rewritten on disk rather than through `modResults` because the dependency
 * writes them with `fs` from inside its own `withXcodeProject` mod; they are
 * not files Expo is managing, so there is no mod to hook.
 *
 * ── `CFBundleDisplayName` — the share sheet label ────────────────
 *
 * `iosShareExtensionName` does two jobs in that dependency and they pull
 * against each other (`plugin/build/ios/constants.js`,
 * `writeIosShareExtensionFiles.js`): it is the **Xcode target name** *and* the
 * extension's `CFBundleDisplayName`.
 *
 * #183's own sketch sets it to `MaybeSitter`, which is the right label and the
 * wrong target name. `withIosShareExtensionXcodeTarget.js` starts with
 * `pbxProject.pbxTargetByName(extensionName)` and returns early if it finds
 * one — and the main app target is already called `MaybeSitter`. The result is
 * silent and total: prebuild logs "MaybeSitter already exists in project.
 * Skipping…", writes the Swift, the storyboard and the plists to disk, and
 * never creates a target to build them. No share extension is produced and
 * MaybeSitter never appears in the iOS share sheet. `expo config --type
 * introspect` shows none of this; the generated `project.pbxproj` does, by
 * having no `com.apple.product-type.app-extension` in it at all.
 *
 * So the target is named `ShareExtension` — distinct, so it is created — and
 * the label is put back here.
 *
 * `PRODUCT_BUNDLE_IDENTIFIER` is untouched: it comes from
 * `getShareExtensionBundledIdentifier`, is independent of the name, and stays
 * `com.maybesitter.app.share-extension`, which is what UC-4.3a (#178) needs.
 *
 * ── `PrivacyInfo.xcprivacy` — the reason the extension actually uses ──
 *
 * The dependency generates the extension a privacy manifest declaring
 * `CA92.1`, which is "the app's own UserDefaults". That is not what
 * `ShareViewController.swift` does: it reads and writes
 * `UserDefaults(suiteName: hostAppGroupIdentifier)` in five places, which is
 * `1C8F.1`. `app.config.ts` declares both for the app for exactly this reason;
 * leaving the extension's own manifest under-declared would be the same
 * inaccuracy in the bundle that actually makes the call, and a required-reason
 * mismatch is something App Review rejects rather than warns about.
 */
function withShareExtensionFiles(config, { targetName, displayName }) {
  return withXcodeProject(config, (modConfig) => {
    const directory = path.join(modConfig.modRequest.platformProjectRoot, targetName);

    rewrite(directory, 'ShareExtension-Info.plist', (plist) => {
      const next = plist.replace(
        /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${displayName}$2`,
      );
      if (next === plist) throw new Error('withShareExtensionFixups: no CFBundleDisplayName to set');
      return next;
    });

    rewrite(directory, 'PrivacyInfo.xcprivacy', (manifest) => {
      if (manifest.includes('1C8F.1')) return manifest;
      const next = manifest.replace(
        /(<string>NSPrivacyAccessedAPICategoryUserDefaults<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>\s*<string>CA92\.1<\/string>)/,
        '$1\n          <string>1C8F.1</string>',
      );
      if (next === manifest) {
        throw new Error('withShareExtensionFixups: the extension privacy manifest is not the shape this patches');
      }
      return next;
    });

    return modConfig;
  });
}

module.exports = function withShareExtensionFixups(config, options) {
  return withShareExtensionFiles(withDedupedAppGroups(config), {
    targetName: options?.targetName ?? 'ShareExtension',
    displayName: options?.displayName ?? 'MaybeSitter',
  });
};
