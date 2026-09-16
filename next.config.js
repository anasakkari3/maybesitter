/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Cloud Run runs the app from a container, so the build has to emit a
  // self-contained server bundle rather than expecting node_modules.
  output: 'standalone',
  // The git root holds sibling worktrees with their own lockfiles. Without
  // this, Next traces from the wrong root and copies the wrong tree.
  outputFileTracingRoot: __dirname,
  // firebase-admin uses native/dynamic requires that must not be bundled.
  serverExternalPackages: ['firebase-admin'],
  // The calendar reader's recurrence worker (UC-3.4, #188) is a plain .mjs file
  // started with `new Worker(path)`, which tracing cannot see. Copy it, the
  // module it imports and ical.js into the standalone output explicitly.
  outputFileTracingIncludes: {
    '/api/**/*': [
      './lib/calendar/icsExpand.worker.mjs',
      './lib/calendar/icsExpand.mjs',
      './node_modules/ical.js/package.json',
      './node_modules/ical.js/dist/**',
    ],
  },
};

module.exports = nextConfig;
