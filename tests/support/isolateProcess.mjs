// Preloaded with `--import` into every `node --test` process (the runner and
// each per-file child). It gives the process its own filesystem and clock:
//
//   - a private root under the OS temp dir, removed on exit;
//   - TMPDIR pointed inside it, so `os.tmpdir()` (which reads TMPDIR on every
//     call on macOS and Linux) is per-process and two files can never see each
//     other's temp entries;
//   - MAYBESITTER_DATA_DIR and the domain-state override pointed inside it,
//     so no test writes to `<checkout>/.maybesitter` and two suites running
//     from the same checkout share nothing. The pilot trust file is gone: the
//     trust record lives in storage since UC-1.0b (#141), and a test isolates
//     it with `setStorageForTests(createMemoryStorage())`;
//   - TZ pinned (UTC unless MAYBESITTER_TEST_TZ says otherwise), so the result
//     does not depend on the shell's zone.
//
// These are set unconditionally, before any test module loads. A test that sets
// one of them itself still wins, because it does so later.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), `maybesitter-test-${process.pid}-`));
const tmp = join(root, 'tmp');
const data = join(root, 'data');
mkdirSync(tmp, { recursive: true });
mkdirSync(data, { recursive: true });

process.env.TMPDIR = tmp;
process.env.MAYBESITTER_DATA_DIR = data;
process.env.MAYBESITTER_DOMAIN_STATE_FILE = join(data, 'domain-state.json');
process.env.TZ = process.env.MAYBESITTER_TEST_TZ || 'UTC';

process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});
