#!/usr/bin/env node
/**
 * Maybesitter process orchestrator
 *
 * Starts Next.js (dev or start) and the reminder worker together.
 *
 * Port selection strategy:
 *   1. Reads PORT from the environment (set by preview_start / the caller).
 *   2. Passes --port PORT directly to `next dev`/`next start`, AND sets
 *      PORT in the child env — so it wins over Next.js's own autoPort logic.
 *
 * Usage:
 *   node scripts/with-worker.mjs dev
 *   node scripts/with-worker.mjs start
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const workerScript = path.join(__dirname, 'reminder-worker.mjs');

const subcommand = process.argv[2];
if (!subcommand || !['dev', 'start'].includes(subcommand)) {
  console.error('[orchestrator] Usage: node scripts/with-worker.mjs dev|start');
  process.exit(1);
}

const port = Number(process.env.PORT) || 3000;
const isWindows = process.platform === 'win32';

let nextProc = null;
let workerProc = null;
let workerStarted = false;
let exiting = false;

// ─── cleanup ───────────────────────────────────────────────────────────────

function stopAll(code = 0) {
  if (exiting) return;
  exiting = true;
  if (workerProc && !workerProc.killed) workerProc.kill('SIGTERM');
  if (nextProc && !nextProc.killed) nextProc.kill('SIGTERM');
  setTimeout(() => process.exit(code), 800);
}

// ─── worker ────────────────────────────────────────────────────────────────

function startWorker() {
  if (workerStarted || exiting) return;
  workerStarted = true;
  console.log(`[orchestrator] Next.js ready on :${port} — starting reminder worker`);

  workerProc = spawn('node', [workerScript], {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(port),
      MAYBESITTER_BASE_URL: `http://localhost:${port}`,
    },
  });

  workerProc.on('exit', (code, signal) => {
    if (exiting) return;
    if (code !== 0 && code !== null) {
      console.error(`[orchestrator] Worker exited with code ${code} — stopping`);
      stopAll(code);
    } else {
      console.log(`[orchestrator] Worker stopped (${signal ?? code})`);
    }
  });
}

// ─── next.js ───────────────────────────────────────────────────────────────

// On Windows, .cmd wrappers always require shell:true.
// We pass --port explicitly so Next.js uses the assigned port, not its own autoPort.
const nextCmd = isWindows ? 'npm' : 'npx';
const nextCmdArgs = isWindows
  ? ['exec', '--', 'next', subcommand, '--port', String(port)]
  : ['--yes', 'next', subcommand, '--port', String(port)];

console.log(`[orchestrator] Starting Next.js "${subcommand}" on port ${port} …`);

nextProc = spawn(nextCmd, nextCmdArgs, {
  cwd: rootDir,
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: true,   // required for .cmd resolution on Windows; harmless on POSIX
  env: { ...process.env, PORT: String(port) },
});

nextProc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (!workerStarted && /✓\s+Ready|Local:\s+http/i.test(text)) {
    startWorker();
  }
});

nextProc.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

nextProc.on('exit', (code) => {
  if (exiting) return;
  console.log(`[orchestrator] Next.js exited with code ${code}`);
  stopAll(code ?? 0);
});

// ─── signals ───────────────────────────────────────────────────────────────

process.on('SIGINT', () => { console.log('\n[orchestrator] SIGINT'); stopAll(0); });
process.on('SIGTERM', () => { console.log('[orchestrator] SIGTERM'); stopAll(0); });
