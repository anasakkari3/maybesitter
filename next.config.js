/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // firebase-admin is a server-only package with optional native and dynamic
  // requires (grpc, protobufjs). Bundling it makes the build trace them and
  // warn; leaving it external is both smaller and what Firebase documents.
  serverExternalPackages: ['firebase-admin'],
};

module.exports = nextConfig;
