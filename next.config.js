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
};

module.exports = nextConfig;
