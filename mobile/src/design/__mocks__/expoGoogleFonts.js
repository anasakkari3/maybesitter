// Jest stub for the @expo-google-fonts/* packages.
//
// Those packages pull in expo-font's native loader, which does not resolve
// under jest-expo. Nothing in a unit test cares which font binary a name maps
// to — only that `family(weight, arabic)` returns a stable string — so every
// exported name resolves to itself.
module.exports = new Proxy(
  {},
  {
    get: (_target, name) => (name === '__esModule' ? false : String(name)),
  },
);
