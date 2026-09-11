#!/usr/bin/env node
// Re-derive the raw token evidence from the Claude Design export.
//
// The export has no :root block and no CSS custom properties — every value is
// an inline literal — so tokens cannot be read, only counted. This prints what
// the design actually uses, ordered by frequency, and the current manifest
// sha256. Use it after a re-export to update src/design/tokens.source.json,
// then run `npm test` : the drift test fails until the sha is updated.
//
// Usage: node scripts/extract-design-tokens.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(repoRoot, 'design', 'MaybeSitter.dc.html'), 'utf8');
const manifest = readFileSync(join(repoRoot, 'design', 'EXPORT_MANIFEST.json'), 'utf8');

function tally(pattern, normalize = (v) => v) {
  const counts = new Map();
  for (const match of html.matchAll(pattern)) {
    const value = normalize(match[1] ?? match[0]);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function print(title, rows) {
  console.log(`\n${title}`);
  for (const [value, count] of rows) console.log(`  ${String(count).padStart(3)}  ${value}`);
}

console.log(`sourceManifestSha: ${createHash('sha256').update(manifest).digest('hex')}`);
print('hex colours', tally(/#[0-9a-fA-F]{6}\b/g, (v) => v.toUpperCase()));
print('rgba()', tally(/rgba\([^)]+\)/g, (v) => v.replace(/\s+/g, '')));
print('border-radius', tally(/border-radius:\s*(\d+)/g));
print('font-size', tally(/font-size:\s*(\d+)/g));
print('font-weight', tally(/font-weight:\s*(\d+)/g));
print('gap', tally(/gap:\s*(\d+)/g));
print('padding (single value)', tally(/padding:\s*(\d+)px/g));
print('animations', tally(/animation:\s*([^;"']+)/g, (v) => v.trim()));
