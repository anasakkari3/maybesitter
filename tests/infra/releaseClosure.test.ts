import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scheduler = join(repoRoot, 'infra', 'scheduler.sh');
const ttl = join(repoRoot, 'infra', 'firestore-ttl.sh');

const expectedJobs = [
  'jobs-tick',
  'daily-plan-tick',
  'hard-reminders-tick',
  'watcher-sweep',
  'replan-tick',
  'ics-feed-refresh',
  'football-sync-daily',
  'maintenance-daily',
] as const;

const expectedTtlGroups = [
  'alphaTraces',
  'clarifications',
  'analyticsEvents',
  'captureProposals',
  'deletionReceipts',
  'accountDeletions',
  'hardReminders',
  'commitmentActionReceipts',
] as const;

const mockGcloud = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$RELEASE_CLOSURE_CALLS"

if [ "$1 $2 $3" = "run services describe" ]; then
  if [[ "$*" == *"value(status.url)"* ]]; then
    printf '%s\n' 'https://staging.example.invalid'
  else
    cat <<JSON
{"spec":{"template":{"spec":{"containers":[{"env":[
  {"name":"MAYBESITTER_SCHEDULER_SA_EMAIL","value":"maybesitter-scheduler@maybesitter-app.iam.gserviceaccount.com"},
  {"name":"MAYBESITTER_INTERNAL_AUDIENCE","value":"https://staging.example.invalid"}
]}]}}}}
JSON
  fi
  exit 0
fi

if [ "$1 $2 $3" = "scheduler jobs describe" ]; then
  name="$4"
  retry_count=0
  retry_duration=0s
  min_backoff=5s
  max_backoff=60s
  case "$name" in
    jobs-tick-staging) schedule='* * * * *'; timezone=Etc/UTC; path=/api/internal/jobs/run ;;
    daily-plan-tick-staging) schedule='* * * * *'; timezone=Etc/UTC; path=/api/internal/jobs/daily-plan ;;
    hard-reminders-tick-staging) schedule='* * * * *'; timezone=Etc/UTC; path=/api/internal/jobs/hard-reminders ;;
    watcher-sweep-staging) schedule='* * * * *'; timezone=Etc/UTC; path=/api/internal/jobs/watchers ;;
    replan-tick-staging) schedule='*/5 * * * *'; timezone=Etc/UTC; path=/api/internal/jobs/replan ;;
    ics-feed-refresh-staging) schedule='*/30 * * * *'; timezone=Etc/UTC; path=/api/internal/calendar/ics/refresh ;;
    football-sync-daily-staging) schedule='0 1 * * *'; timezone=Asia/Jerusalem; path=/api/internal/jobs/football-sync; retry_count=3; retry_duration=900s; min_backoff=30s; max_backoff=300s ;;
    maintenance-daily-staging) schedule='17 3 * * *'; timezone=Asia/Jerusalem; path=/api/internal/jobs/maintenance; retry_count=3; retry_duration=900s; min_backoff=30s; max_backoff=300s ;;
    *) exit 1 ;;
  esac
  cat <<JSON
{"state":"ENABLED","schedule":"$schedule","timeZone":"$timezone","httpTarget":{"httpMethod":"POST","uri":"https://staging.example.invalid$path","oidcToken":{"serviceAccountEmail":"maybesitter-scheduler@maybesitter-app.iam.gserviceaccount.com","audience":"https://staging.example.invalid"}},"attemptDeadline":"60s","retryConfig":{"retryCount":$retry_count,"maxRetryDuration":"$retry_duration","minBackoffDuration":"$min_backoff","maxBackoffDuration":"$max_backoff","maxDoublings":3}}
JSON
  exit 0
fi

if [ "$1 $2 $3 $4" = "firestore fields ttls list" ]; then
  groups='["alphaTraces","clarifications","analyticsEvents","captureProposals","deletionReceipts","accountDeletions","hardReminders","commitmentActionReceipts"]'
  if [ "\${RELEASE_CLOSURE_OMIT_TTL:-}" = "hardReminders" ]; then
    groups='["alphaTraces","clarifications","analyticsEvents","captureProposals","deletionReceipts","accountDeletions","commitmentActionReceipts"]'
  fi
  node -e 'const groups=JSON.parse(process.argv[1]); console.log(JSON.stringify(groups.map(group => ({name: "/projects/p/databases/(default)/collectionGroups/"+group+"/fields/expiresAt", ttlConfig:{state:"ACTIVE"}}))))' "$groups"
  exit 0
fi

echo "unexpected mutating or unknown gcloud call: $*" >&2
exit 64
`;

const withMockGcloud = (run: (env: NodeJS.ProcessEnv, calls: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-closure-test-'));
  const calls = join(dir, 'calls.log');
  try {
    writeFileSync(join(dir, 'gcloud'), mockGcloud, { mode: 0o755 });
    writeFileSync(calls, '');
    run({ ...process.env, PATH: `${dir}:${process.env.PATH}`, RELEASE_CLOSURE_CALLS: calls }, calls);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('Scheduler manifest declares every production job and explicit retry/deadline controls', () => {
  const source = readFileSync(scheduler, 'utf8');
  for (const name of expectedJobs) {
    assert.match(source, new RegExp(`upsert_job "${name}-\\$\\{SUFFIX\\}"`), `missing ${name}`);
  }
  assert.match(source, /--attempt-deadline=60s/);
  assert.match(source, /--max-retry-attempts=/);
  assert.match(source, /--max-retry-duration=/);
  assert.match(source, /football-sync-daily[^\n]*[\s\S]*?3 900s 30s 300s/);
  assert.match(source, /maintenance-daily[^\n]*[\s\S]*?3 900s 30s 300s/);
});

test('Scheduler check proves OIDC, targets, schedules, retries and timeouts without mutating cloud state', () => {
  withMockGcloud((env, calls) => {
    const result = spawnSync('bash', [scheduler, '--check', 'staging'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /scheduler check: all checks passed for staging/);
    const invoked = readFileSync(calls, 'utf8');
    assert.doesNotMatch(invoked, /run services update/);
    assert.doesNotMatch(invoked, /scheduler jobs (create|update)/);
    for (const name of expectedJobs) assert.match(invoked, new RegExp(`scheduler jobs describe ${name}-staging`));
  });
});

test('TTL check covers every retention group and performs no update', () => {
  const source = readFileSync(ttl, 'utf8');
  for (const group of expectedTtlGroups) assert.match(source, new RegExp(`"${group}"`), `missing ${group}`);

  withMockGcloud((env, calls) => {
    const result = spawnSync('bash', [ttl, '--project', 'maybesitter-app', '--check'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /TTL check: all policies are active/);
    assert.doesNotMatch(readFileSync(calls, 'utf8'), /ttls update/);
  });
});

test('TTL check fails closed when one required policy is absent', () => {
  withMockGcloud((env) => {
    const result = spawnSync('bash', [ttl, '--check'], {
      env: { ...env, RELEASE_CLOSURE_OMIT_TTL: 'hardReminders' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /hardReminders[\s\S]*MISSING/);
    assert.match(result.stderr, /1 required policy\/policies are not active/);
  });
});
