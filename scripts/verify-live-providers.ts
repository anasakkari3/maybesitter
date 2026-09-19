/**
 * Run the live provider probes and print safe evidence (expansion program).
 *
 * Opt-in, and inert without it:
 *
 *   MAYBESITTER_LIVE_PROVIDER_VERIFICATION=1 \
 *     MAYBESITTER_LIVE_GOOGLE_ACCESS_TOKEN=… \
 *     node --loader ./scripts/ts-resolver.mjs scripts/verify-live-providers.ts
 *
 * Without the flag nothing is contacted, every probe reports a skip and the
 * exit code is 0 — which is why this is safe to wire into a pipeline that has
 * no credentials, and why ordinary `npm test` never depends on a provider
 * being up.
 *
 * ── It will skip everything today, and that is the point ─────────
 *
 * A probe needs a `ProviderReadPort`, and this repository ships none: the
 * provider adapters on main are normalizers behind ports whose only
 * implementations are test doubles. There is no HTTP client, no OAuth code
 * exchange and no credential vault. So every probe reports
 * SKIPPED_UNSUPPORTED_LIVE_PROBE until a port is registered below, and no
 * provider may be called "verified live" before then.
 *
 * Registering one is the whole extension point: build the object that
 * production will use to talk to the provider, put it in the map, and the
 * probe starts proving that real responses still satisfy the adapters.
 */
import {
  liveVerificationEnabled,
  probesAreClean,
  probeReport,
  runProviderProbes,
  type ProbeResult,
  type ProviderReadPort,
} from '../lib/verification/liveProviderVerification.ts';
import {
  PROVIDERS_WITHOUT_LIVE_PROBES,
  PROVIDER_PROBES,
} from '../lib/verification/providerProbeCatalog.ts';
import { createGmailTransport } from '../lib/integrations/gmail/production/gmailTransport.ts';
import type { ContextProviderKind } from '../src/contracts/v1/integrationConnectionContracts.ts';

/**
 * The transports available to this run.
 *
 * Nothing here fabricates a provider client, because a client written for
 * verification would not be the client production uses, and then a green run
 * would mean nothing. Gmail is registered because Phase B built the *production*
 * transport and this is the same object wearing a second face — see
 * `asReadPort` in `lib/integrations/gmail/production/gmailTransport.ts`.
 *
 * It still cannot run without a credential. `MAYBESITTER_LIVE_GOOGLE_ACCESS_TOKEN`
 * is checked by the probe before the port is reached, so with no token this
 * reports SKIPPED_MISSING_CREDENTIALS rather than PASS.
 */
function buildPorts(env: NodeJS.ProcessEnv): Map<ContextProviderKind, ProviderReadPort> {
  const map = new Map<ContextProviderKind, ProviderReadPort>();
  const googleToken = env.MAYBESITTER_LIVE_GOOGLE_ACCESS_TOKEN;
  if (typeof googleToken === 'string' && googleToken.trim() !== '') {
    // A verification run is given a token directly rather than a vault: this
    // harness has no uid, so there is no account whose vault it could open.
    // Production builds the same transport over
    // `createProviderAccessTokenProvider` instead.
    map.set('google', createGmailTransport({ accessToken: async () => googleToken }).asReadPort());
  }
  return map;
}

const ports = buildPorts(process.env);

function line(result: ProbeResult): string {
  const parts = [
    result.status.padEnd(30),
    `${result.provider}/${result.operation}`,
    result.contractValidated ? 'contract:validated' : 'contract:unchecked',
    result.latencyMs === null ? 'latency:-' : `latency:${result.latencyMs}ms`,
    result.recordCount === null ? 'records:-' : `records:${result.recordCount}`,
  ];
  if (result.failureCategory) parts.push(`category:${result.failureCategory}`);
  // `detail` is redacted at the source, in the runner, not here.
  if (result.detail) parts.push(`(${result.detail})`);
  return parts.join('  ');
}

async function main(): Promise<void> {
  const enabled = liveVerificationEnabled();
  const asJson = process.argv.includes('--json');

  if (asJson) {
    const results = await runProviderProbes(PROVIDER_PROBES, { ports });
    // Only the document goes to stdout, so the output is parseable without
    // stripping a banner off the front of it.
    console.log(JSON.stringify(probeReport(results, enabled), null, 2));
    // Unchanged on purpose: the exit code still means "clean", and skips still
    // count as clean. The distinction now lives in `outcome`, where a reader
    // can act on it, rather than being redefined underneath existing callers.
    process.exitCode = probesAreClean(results) ? 0 : 1;
    return;
  }

  console.log(`live provider verification: ${enabled ? 'enabled' : 'disabled (opt-in flag not set)'}`);
  console.log('');

  const results = await runProviderProbes(PROVIDER_PROBES, { ports });
  for (const result of results) console.log(line(result));

  console.log('');
  const verified = results.filter((entry) => entry.status === 'PASS').length;
  console.log(`probes: ${results.length}  contract-validated: ${verified}`);

  if (verified === 0) {
    console.log('');
    console.log('No provider is verified live. Providers remain: TESTED WITH MOCK / LIVE VERIFICATION READY.');
  }

  console.log('');
  console.log('Not covered by this harness:');
  for (const entry of PROVIDERS_WITHOUT_LIVE_PROBES) {
    console.log(`  ${entry.provider}: ${entry.reason}`);
  }

  // Skips are not failures: a pipeline without credentials stays green.
  process.exitCode = probesAreClean(results) ? 0 : 1;
}

void main();
