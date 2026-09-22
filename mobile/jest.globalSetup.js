/*
 * The zone this suite runs in, pinned before any worker exists (#413).
 *
 * The backend does this in `tests/support/isolateProcess.mjs`, preloaded with
 * `--import` into every `node --test` process. `jest.setup.js` is the obvious
 * mobile equivalent and is the **wrong place**: `setupFiles` runs inside a
 * worker that has already started, and the `process` a test sees is the
 * environment's own object, so assigning `TZ` there sets the variable without
 * notifying V8. Measured, not assumed — with the assignment in `jest.setup.js`
 * the assertion in `src/__tests__/jestZone.test.ts` reported `process.env.TZ`
 * as 'UTC' and `getTimezoneOffset()` as -180, which is the pin's own failure
 * mode: written, never applied, and worth nothing.
 *
 * `globalSetup` runs once in the real Node process before any worker is
 * forked, and workers inherit the environment as it stands then. That is early
 * enough for the runtime to pick it up.
 *
 * `MAYBESITTER_TEST_TZ` overrides it, exactly as on the backend, so running
 * the suite under a second zone stays one variable away.
 */
module.exports = async () => {
  process.env.TZ = process.env.MAYBESITTER_TEST_TZ || 'UTC';
};
