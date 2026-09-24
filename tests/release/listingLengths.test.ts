import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateListings, readListings } from '../../docs/release/check_listing_lengths.mjs';

function fixtures() {
  const apple = { configVersion: 0, apple: { info: Object.fromEntries(['en-US', 'ar-SA', 'he'].map(locale => [locale, {
    title: 'Synthetic listing', subtitle: 'Synthetic subtitle', description: 'Synthetic description for a fixture.', keywords: ['synthetic', 'fixture'],
  }])) } };
  const play = { locales: ['en-US', 'ar', 'iw-IL'].map(locale => ({ locale, title: 'Synthetic listing', shortDescription: 'Synthetic short description', fullDescription: 'Synthetic full description' })) };
  return { apple, play };
}

test('complete synthetic inputs pass without implying approval', () => {
  const { apple, play } = fixtures();
  assert.deepEqual(validateListings(apple, play).errors, []);
});

test('all required localized fields reject empty or missing values', () => {
  const { apple, play } = fixtures();
  delete apple.apple.info.he;
  apple.apple.info['en-US'].title = '  ';
  apple.apple.info['ar-SA'].keywords = [];
  play.locales[1].shortDescription = '';
  play.locales.pop();
  const errors = validateListings(apple, play).errors.join('\n');
  for (const field of ['apple.info.he', 'en-US.title', 'ar-SA.keywords', 'play.ar.shortDescription', 'play.iw-IL']) assert.ok(errors.includes(field));
});

test('unknown and duplicate locales cannot silently pass', () => {
  const { apple, play } = fixtures();
  apple.apple.info.ar = apple.apple.info['ar-SA'];
  play.locales.push(play.locales[0]);
  assert.match(validateListings(apple, play).errors.join('\n'), /unexpected locale/);
  assert.match(validateListings(apple, play).errors.join('\n'), /exactly one locale entry/);
});

test('each field accepts its boundary and rejects one extra Unicode code point', () => {
  for (const [platform, key, limit] of [
    ['apple', 'title', 30], ['apple', 'subtitle', 30], ['apple', 'description', 4000],
    ['play', 'title', 30], ['play', 'shortDescription', 80], ['play', 'fullDescription', 4000],
  ] as const) {
    const { apple, play } = fixtures();
    const target: Record<string, string | string[]> = platform === 'apple' ? apple.apple.info['en-US'] : play.locales[0];
    target[key] = 'ש'.repeat(limit - 1) + '😀';
    assert.deepEqual(validateListings(apple, play).errors, [], key);
    target[key] = String(target[key]) + 'ا';
    assert.ok(validateListings(apple, play).errors.some((error: string) => error.includes(key)), key);
  }
});

test('keywords count combined commas and Arabic/Hebrew UTF-8 bytes', () => {
  const { apple, play } = fixtures();
  apple.apple.info['ar-SA'].keywords = ['ا'.repeat(49) + 'ab'];
  assert.deepEqual(validateListings(apple, play).errors, []); // 100 bytes
  apple.apple.info['ar-SA'].keywords = ['ا'.repeat(49), 'אב'];
  assert.match(validateListings(apple, play).errors.join('\n'), /100 UTF-8 bytes/); // 103 with comma
  apple.apple.info['ar-SA'].keywords = ['a'.repeat(50), 'b'.repeat(50)];
  assert.match(validateListings(apple, play).errors.join('\n'), /including commas/);
});

test('malformed structures, keyword values and duplicate keywords fail', () => {
  assert.ok(validateListings({}, {}).errors.length >= 2);
  const { apple, play } = fixtures();
  apple.apple.info.he.keywords = ['duplicate', 'duplicate'];
  assert.match(validateListings(apple, play).errors.join('\n'), /duplicate keywords/);
  apple.apple.info.he.keywords = [null] as never;
  assert.match(validateListings(apple, play).errors.join('\n'), /non-empty strings/);
});

test('ordinary lowercase todo copy passes while an explicit TODO marker fails', () => {
  const { apple, play } = fixtures();
  apple.apple.info['en-US'].keywords = ['todo', 'reminders'];
  apple.apple.info['en-US'].description = 'A synthetic todo list description.';
  play.locales[0].shortDescription = 'A synthetic todo list';
  assert.deepEqual(validateListings(apple, play).errors, []);
  apple.apple.info['en-US'].keywords = ['TODO'];
  assert.match(validateListings(apple, play).errors.join('\n'), /unresolved placeholder/);
});

test('placeholders fail without returning their content', () => {
  for (const value of ['{{LEGAL_NAME}}', 'TBD', 'https://example.com/privacy', '<domain>']) {
    const { apple, play } = fixtures();
    apple.apple.info.he.description = `Synthetic secret ${value}`;
    const result = validateListings(apple, play);
    assert.match(result.errors.join('\n'), /unresolved placeholder/);
    assert.ok(!JSON.stringify(result).includes('Synthetic secret'));
  }
});

test('CLI and markdown parser fail closed and never expose invalid JSON content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'listing-check-'));
  const a = join(dir, 'apple.json'), p = join(dir, 'play.md');
  const script = resolve('docs/release/check_listing_lengths.mjs');
  const cli = () => spawnSync(process.execPath, [script, a, p], { encoding: 'utf8', cwd: tmpdir() });
  try {
    assert.equal(cli().status, 1);
    assert.match(cli().stderr, /apple: file missing/);
    assert.match(cli().stderr, /play: file missing/);
    writeFileSync(a, '{private malformed sentinel');
    writeFileSync(p, '# No listing');
    assert.equal(cli().status, 1);
    assert.ok(!cli().stderr.includes('sentinel'));
    const { apple, play } = fixtures();
    writeFileSync(a, JSON.stringify(apple));
    const block = '```json play-listing\n' + JSON.stringify(play) + '\n```\n';
    writeFileSync(p, block + block);
    assert.match(readListings(a, p).errors.join('\n'), /exactly one/);
    writeFileSync(p, block.replaceAll('\n', '\r\n'));
    assert.equal(cli().status, 0);
    assert.match(cli().stdout, /not owner approval or submission readiness/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
