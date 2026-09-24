#!/usr/bin/env node
/** Local #205 preflight only: no console calls, approval or publication. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const placeholder = /\{\{[^}]*\}\}|\b(?:TODO|TBD|FIXME|PLACEHOLDER)\b|<(?:domain|support_email|legal_name|[^>]*placeholder[^>]*)>|https?:\/\/[^\s/]*example\.(?:com|org|net)\b/i;

export function validateListings(apple, play) {
  const errors = [];
  const counts = [];
  const problem = (path, message) => errors.push(`${path}: ${message}`);
  function field(value, path, max, min = 1) {
    if (typeof value !== 'string' || !value.trim()) {
      problem(path, 'required non-empty string');
      return;
    }
    if (placeholder.test(value)) problem(path, 'unresolved placeholder');
    const count = Array.from(value).length;
    counts.push(`${path}: ${count}/${max} characters`);
    if (count < min || count > max) problem(path, `length must be ${min}..${max} characters`);
  }
  if (!object(apple) || apple.configVersion !== 0 || !object(apple.apple?.info)) {
    problem('apple', 'expected configVersion 0 and apple.info object');
  } else {
    const locales = ['en-US', 'ar-SA', 'he'];
    if (Object.keys(apple.apple.info).some(locale => !locales.includes(locale))) {
      problem('apple.info', 'unexpected locale (expected en-US, ar-SA, he)');
    }
    for (const locale of locales) {
      const entry = apple.apple.info[locale];
      const prefix = `apple.info.${locale}`;
      if (!object(entry)) { problem(prefix, 'missing locale object'); continue; }
      field(entry.title, `${prefix}.title`, 30, 2);
      field(entry.subtitle, `${prefix}.subtitle`, 30);
      field(entry.description, `${prefix}.description`, 4000, 10);
      if (!Array.isArray(entry.keywords) || !entry.keywords.length ||
          entry.keywords.some(word => typeof word !== 'string' || !word.trim())) {
        problem(`${prefix}.keywords`, 'required non-empty array of non-empty strings');
      } else {
        if (new Set(entry.keywords).size !== entry.keywords.length) problem(`${prefix}.keywords`, 'duplicate keywords');
        const joined = entry.keywords.join(',');
        field(joined, `${prefix}.keywords`, 100);
        const bytes = Buffer.byteLength(joined, 'utf8');
        counts.push(`${prefix}.keywords: ${bytes}/100 UTF-8 bytes including commas`);
        if (bytes > 100) problem(`${prefix}.keywords`, 'exceeds 100 UTF-8 bytes including commas');
      }
    }
  }
  if (!object(play) || !Array.isArray(play.locales)) {
    problem('play', 'expected locales array');
  } else {
    const locales = ['en-US', 'ar', 'iw-IL'];
    if (play.locales.some(entry => !object(entry) || !locales.includes(entry.locale))) {
      problem('play.locales', 'unexpected locale (expected en-US, ar, iw-IL)');
    }
    for (const locale of locales) {
      const entries = play.locales.filter(entry => object(entry) && entry.locale === locale);
      const prefix = `play.${locale}`;
      if (entries.length !== 1) { problem(prefix, 'expected exactly one locale entry'); continue; }
      field(entries[0].title, `${prefix}.title`, 30);
      field(entries[0].shortDescription, `${prefix}.shortDescription`, 80);
      field(entries[0].fullDescription, `${prefix}.fullDescription`, 4000);
    }
  }
  return { errors, counts };
}

export function readListings(applePath, playPath) {
  const errors = [];
  function read(path, label) {
    try { return readFileSync(path, 'utf8'); }
    catch { errors.push(`${label}: file missing or unreadable`); return null; }
  }
  function json(text, label) {
    try { return JSON.parse(text); }
    catch { errors.push(`${label}: invalid JSON`); return null; }
  }
  const appleText = read(applePath, 'apple');
  const playText = read(playPath, 'play');
  const apple = appleText === null ? null : json(appleText, 'apple');
  let play = null;
  if (playText !== null) {
    const blocks = [...playText.matchAll(/^```json play-listing\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
    if (blocks.length !== 1) errors.push('play: expected exactly one json play-listing fenced block');
    else play = json(blocks[0][1], 'play');
  }
  if (errors.length) return { errors, counts: [] };
  return validateListings(apple, play);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && args.length !== 2) {
    console.error('Usage: node docs/release/check_listing_lengths.mjs [apple-json play-markdown]');
    process.exitCode = 1;
  } else {
    const result = readListings(args[0] ?? resolve(root, 'mobile/store.config.json'),
      args[1] ?? resolve(root, 'docs/release/store-listing-v1.md'));
    for (const count of result.counts) console.log(count);
    for (const error of result.errors) console.error(error);
    if (result.errors.length) process.exitCode = 1;
    else console.log('PASS: listing length/structure preflight only; not owner approval or submission readiness.');
  }
}
