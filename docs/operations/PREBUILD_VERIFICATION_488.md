# Prebuild verification handoff for #488

#488 changes two things: CI moves from Node 22 to Node 24, and the mobile
lockfile is regenerated once under npm 11. The lockfile delta is exactly one
removed key —
`node_modules/@bacons/apple-targets/node_modules/typescript` — and nothing
else.

That one key is the reason this document exists. It cannot be checked by the
integration lane, and it must be checked before #488 merges.

## Why a prebuild is required

`@bacons/apple-targets/node_modules/@expo/require-utils` declares a peer on
`typescript: ^5.0.0 || ^5.0.0-0` — TypeScript 5 only. Mobile's root pin is
`~6.0.3`. npm 10 satisfies that peer by materialising a nested
`typescript@5.9.3`; npm 11 does not, so it disappears from any lock regenerated
today.

After #488, `@expo/require-utils` resolves to the root TypeScript 6, which is
**outside its declared peer range**. Nothing in Jest, `tsc` or lint touches
that path: `@bacons/apple-targets` is the iOS **native target** tool behind the
widget work in #203, and it only runs during `expo prebuild`. So the JavaScript
suites can be entirely green while the native target generation is broken.

CI on #488 is 9/9 green. That green does not cover this.

## Owner

The S3/UAT lane, because it owns simulator and native verification. The
integration lane deliberately did not run it during the RC freeze, to avoid
contaminating the RC UAT environment — concurrent sessions sharing the bundle
id have corrupted simulator results before.

Run it **after** the RC UAT verdict, not during.

## Steps

1. Use an **isolated worktree**, not the RC checkout and not the shared main
   checkout:

   ```
   git worktree add --detach ../verify-488 origin/program/ci-node-24-align
   ```

2. Confirm the environment is the one #488 targets:

   ```
   node --version   # expect v24.x
   npm --version    # expect 11.x
   ```

   On npm 10 this check proves nothing: npm 10 is what wants the nested
   TypeScript, so it would fail at install for the very reason #488 removes.

3. Clean install from the regenerated lock:

   ```
   cd ../verify-488/mobile && npm ci
   ```

   This must succeed. If it reports `Missing: typescript@5.9.3`, the shell is
   on npm 10 — go back to step 2.

4. Generate the native projects:

   ```
   npx expo prebuild --clean
   ```

5. Check what the lockfile change actually risks:
   - `expo prebuild` completes without a TypeScript peer or runtime error;
   - the iOS project is generated;
   - **the `@bacons/apple-targets` widget target is generated**, and the
     generated target appears in the Xcode project rather than being silently
     skipped;
   - no error mentioning `@expo/require-utils`, `require-utils`, or a
     TypeScript version.

6. Compile far enough to prove the native target builds — an iOS build or a
   compile check of the generated project. A successful prebuild alone does not
   prove the widget target compiles.

7. Do not leave the app installed on the simulator, and do not run the RC UAT
   from this worktree. Remove it when finished:

   ```
   git worktree remove ../verify-488
   ```

## What each outcome means

- **Prebuild and the widget target both succeed** → #488 is clear to merge,
  and with it the six blocked mobile dependency PRs.
- **Prebuild fails, or the widget target is missing or does not compile** →
  #488 must not merge as written. The fix is then to keep `@bacons/apple-
  targets` on a TypeScript 5 it accepts — a targeted `overrides` entry pinning
  its nested TypeScript — rather than reverting to Node 22, which would leave
  every mobile dependency PR permanently blocked.

Either way, report the outcome before #488 is merged. A green JavaScript CI is
not evidence about this path.
