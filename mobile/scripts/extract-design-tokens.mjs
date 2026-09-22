#!/usr/bin/env node
// Re-derive the raw token evidence from the Claude Design export.
//
// Round 1 had no :root block and no CSS custom properties — every value was an
// inline literal, so tokens could not be read, only counted by frequency.
// Round 2 declares them: `renderVals()` builds one custom-property string per
// scheme, plus a type ramp and per-platform safe areas. So this script now
// reads the named tokens directly, and still tallies the raw literals, because
// plenty of radii, gaps and weights remain inline.
//
// Usage: node scripts/extract-design-tokens.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestRaw = readFileSync(join(repoRoot, 'design', 'EXPORT_MANIFEST.json'), 'utf8');
const manifest = JSON.parse(manifestRaw);
const html = readFileSync(join(repoRoot, 'design', manifest.entry), 'utf8');

function print(title, rows) {
  console.log(`\n${title}`);
  for (const [value, count] of rows) console.log(`  ${String(count).padStart(3)}  ${value}`);
}

function tally(pattern, normalize = (v) => v) {
  const counts = new Map();
  for (const match of html.matchAll(pattern)) {
    const value = normalize(match[1] ?? match[0]);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// ── named custom properties (Round 2 onwards) ────────────────────
// Each block is a single quoted or backquoted string of `--name:value;` pairs.
function declared(label, anchor) {
  const re = new RegExp("['\"`](" + anchor + "[^'\"`]*)['\"`]");
  const block = re.exec(html);
  if (!block) return console.log(`\n${label}\n  (not found — did the export stop declaring it?)`);
  console.log(`\n${label}`);
  for (const pair of block[1].split(';')) {
    const at = pair.indexOf(':');
    if (at > 0) console.log(`  ${pair.slice(0, at).trim().padEnd(12)}  ${pair.slice(at + 1).trim()}`);
  }
}

console.log(`entry:              ${manifest.entry}`);
console.log(`sourceManifestSha:  ${createHash('sha256').update(manifestRaw).digest('hex')}`);
declared('colour tokens — light', '--bg:#F5F7F8');
declared('colour tokens — dark', '--bg:#101416');
declared('type ramp (× --ts: 1 / 1.2 / 1.45)', '--ts:');
declared('safe area — ios', '--safeTop:58px');
declared('safe area — android', '--safeTop:14px');
declared('safe area — bare', '--safeTop:22px');
print('border-radius (inline)', tally(/border-radius:\s*(\d+)/g));
print('font-weight (inline)', tally(/font-weight:\s*(\d+)/g));
print('gap (inline)', tally(/gap:\s*(\d+)/g));
print('padding, single value (inline)', tally(/padding:\s*(\d+)px/g));
print('animations', tally(/animation:\s*([^;"']+)/g, (v) => v.trim()));
