// Metro config for the one place the app runs code from outside `mobile/`.
//
// The native readiness bridges (`src/features/readiness/*DeviceAdapter.ts`)
// build their snapshot with the server's own normalizer
// (`lib/integrations/{healthkit,healthConnect,readiness}`) and its contract
// types (`src/contracts/v1`), so the phone and the route agree on the shape by
// construction rather than by a copy. Metro only resolves files inside its
// watch folders, and without these the bundle fails the moment a screen
// imports the adapter. The list is exactly those directories: nothing else in
// the server tree is reachable from the app.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const repoRoot = path.resolve(__dirname, '..');

config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.join(repoRoot, 'lib', 'integrations', 'healthkit'),
  path.join(repoRoot, 'lib', 'integrations', 'healthConnect'),
  path.join(repoRoot, 'lib', 'integrations', 'readiness'),
  path.join(repoRoot, 'src', 'contracts', 'v1'),
];

module.exports = config;
