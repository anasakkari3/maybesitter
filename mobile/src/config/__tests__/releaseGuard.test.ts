import { describe, expect, it } from '@jest/globals';
import { releaseConfigProblems } from '../releaseGuard';

// The Flutter client shipped a release build pointing at http://localhost:3000
// and nobody found out until it was installed. Each row here is a build that
// must never reach a tester.
describe('releaseConfigProblems', () => {
  const cases: Array<{ name: string; env: Parameters<typeof releaseConfigProblems>[0]; safe: boolean }> = [
    { name: 'empty URL in production', env: { appEnv: 'production', apiBaseUrl: '' }, safe: false },
    { name: 'missing URL key in staging', env: { appEnv: 'staging' }, safe: false },
    { name: 'plain http', env: { appEnv: 'production', apiBaseUrl: 'http://api.example.com' }, safe: false },
    { name: 'https localhost', env: { appEnv: 'production', apiBaseUrl: 'https://localhost' }, safe: false },
    { name: 'android emulator host', env: { appEnv: 'staging', apiBaseUrl: 'https://10.0.2.2:3000' }, safe: false },
    { name: 'private LAN address', env: { appEnv: 'production', apiBaseUrl: 'https://192.168.1.20' }, safe: false },
    { name: '172.16/12 private range', env: { appEnv: 'production', apiBaseUrl: 'https://172.20.0.5' }, safe: false },
    { name: '.invalid host', env: { appEnv: 'staging', apiBaseUrl: 'https://pilot.example.invalid' }, safe: false },
    { name: '.local host', env: { appEnv: 'staging', apiBaseUrl: 'https://mac-mini.local' }, safe: false },
    { name: 'unparsable URL', env: { appEnv: 'production', apiBaseUrl: 'not a url' }, safe: false },
    { name: 'dev bearer token set', env: { appEnv: 'production', apiBaseUrl: 'https://api.example.com', devBearerToken: 'x' }, safe: false },
    { name: 'unknown appEnv', env: { appEnv: 'prod', apiBaseUrl: 'https://api.example.com' }, safe: false },
    { name: 'missing appEnv', env: { apiBaseUrl: 'https://api.example.com' }, safe: false },
    { name: 'real https host in production', env: { appEnv: 'production', apiBaseUrl: 'https://api.example.com' }, safe: true },
    { name: 'real https host in staging', env: { appEnv: 'staging', apiBaseUrl: 'https://staging.example.com' }, safe: true },
    // Development is allowed to point at a laptop; that is the whole point of it.
    { name: 'localhost in development', env: { appEnv: 'development', apiBaseUrl: 'http://localhost:3000' }, safe: true },
    { name: 'android emulator host in development', env: { appEnv: 'development', apiBaseUrl: 'http://10.0.2.2:3000' }, safe: true },
    { name: 'dev bearer token in development', env: { appEnv: 'development', apiBaseUrl: 'http://localhost:3000', devBearerToken: 'x' }, safe: true },
  ];

  for (const { name, env, safe } of cases) {
    it(`${safe ? 'accepts' : 'rejects'}: ${name}`, () => {
      const problems = releaseConfigProblems(env);
      if (safe) expect(problems).toEqual([]);
      else expect(problems.length).toBeGreaterThan(0);
    });
  }

  it('names every problem it found, not just the first', () => {
    const problems = releaseConfigProblems({
      appEnv: 'production',
      apiBaseUrl: 'http://127.0.0.1:3000',
      devBearerToken: 'leaked',
    });
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toMatch(/https/);
    expect(problems.join(' ')).toMatch(/local or private host/);
    expect(problems.join(' ')).toMatch(/DEV_BEARER_TOKEN/);
  });
});
