/**
 * Live provider verification: the runner (expansion program).
 *
 * The provider adapters merged on main — Gmail, Microsoft Graph, Todoist,
 * Notion, RescueTime, WHOOP, meetings, RevenueCat — are *normalizers*. Each
 * turns a provider payload into a provider-independent model, and each is
 * covered by unit tests that feed it a payload written by hand. Nothing in the
 * repository has ever fed one a payload that a real provider produced, so
 * nothing would notice the day a provider changes its response shape.
 *
 * That is what this runs: a real response through the *production* normalizer
 * and out into the *production* model. An HTTP 200 proves nothing here; the
 * proof is that the response still satisfies the contract the rest of the
 * product reads.
 *
 * ── What this deliberately is not ────────────────────────────────
 *
 * It is not a second integration. It owns no HTTP, no OAuth, no credential
 * storage and no provider logic, because duplicating any of those is how the
 * thing under verification and the thing verifying it drift into disagreeing.
 * The transport arrives as a `ProviderReadPort` the caller supplies. The
 * repository ships no implementation of that port today — see
 * `providerProbeCatalog.ts` — so every probe reports
 * `SKIPPED_UNSUPPORTED_LIVE_PROBE` until one is registered, which is the
 * honest answer rather than a green tick.
 *
 * ── Why the port has exactly one method ──────────────────────────
 *
 * `read`, and nothing else. A probe cannot send mail, create a task or mutate
 * a page because the only verb it can reach is a read. That is a structural
 * guarantee rather than a rule someone has to remember, and
 * `refuseNonReadOnlyProbe` covers the one path that could still get it wrong.
 */
import {
  classifyProviderFailure,
  type ProviderFailure,
} from '../integrations/providers/providerRuntime';
import type { ContextProviderKind } from '../../src/contracts/v1/integrationConnectionContracts';

/** Every outcome a probe can report. Deliberately closed. */
export type ProbeStatus =
  | 'PASS'
  | 'SKIPPED_MISSING_CREDENTIALS'
  | 'SKIPPED_UNSUPPORTED_LIVE_PROBE'
  | 'AUTH_FAILED'
  | 'SCOPE_INSUFFICIENT'
  | 'PROVIDER_ERROR'
  | 'CONTRACT_MISMATCH';

/**
 * A probe's evidence.
 *
 * Every field here is either a category this file produced or a count. No
 * provider content reaches it, which is why it is safe to print and to keep.
 */
export interface ProbeResult {
  readonly provider: ContextProviderKind;
  readonly operation: string;
  readonly status: ProbeStatus;
  /** True only when a real response went through the production normalizer. */
  readonly contractValidated: boolean;
  readonly latencyMs: number | null;
  /** How many records normalized, when that is meaningful. Never content. */
  readonly recordCount: number | null;
  /** The canonical `ProviderFailure['kind']`, not a second taxonomy. */
  readonly failureCategory: string | null;
  /** Already redacted. Safe to log. */
  readonly detail: string | null;
  readonly at: string;
}

/**
 * The transport, supplied by the caller.
 *
 * One verb. A probe that wants to write has nothing to call.
 */
export interface ProviderReadPort {
  readonly provider: ContextProviderKind;
  read(request: {
    readonly operation: string;
    readonly limit: number;
  }): Promise<unknown>;
}

/** What a normalizer returned, reduced to something safe to report. */
export interface ProbeNormalization {
  readonly recordCount: number | null;
}

export interface ProbeContext {
  readonly now: string;
  readonly connectionId: string;
}

export interface ProviderProbe {
  readonly provider: ContextProviderKind;
  readonly operation: string;
  /**
   * The environment variables that must all be present for this probe to run.
   * The runner only ever checks that they are set; it never reads, copies or
   * reports a value.
   */
  readonly credentialEnvVars: readonly string[];
  /** Always true. The runner refuses anything else. */
  readonly readOnly: true;
  /** How many records to ask the provider for. Bounded by construction. */
  readonly limit: number;
  /**
   * The production normalizer. Throwing is how a contract mismatch is
   * reported, because that is what the adapters already do on a malformed
   * payload.
   */
  normalize(raw: unknown, context: ProbeContext): ProbeNormalization;
}

/** An error a port may throw to carry the provider's HTTP status through. */
export class ProviderProbeHttpError extends Error {
  constructor(readonly httpStatus: number, message = `provider responded ${httpStatus}`) {
    super(message);
    this.name = 'ProviderProbeHttpError';
  }
}

const SECRET_HINTS = [
  /bearer\s+[\w.\-~+/]+=*/gi,
  /\b(access|refresh|id)[_-]?token["'\s:=]+[\w.\-~+/]+=*/gi,
  /\bauthorization["'\s:=]+[\w.\-~+/]+=*/gi,
  /\b(client[_-]?secret|api[_-]?key)["'\s:=]+[\w.\-~+/]+=*/gi,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
];

/**
 * Redaction, applied to anything derived from a provider or an error.
 *
 * It is deliberately aggressive and deliberately last: a message is truncated
 * after redacting, so a secret cannot survive by sitting past the cut. The
 * point is not to produce a readable error, it is to produce one that cannot
 * carry a credential into a log.
 */
export function redactSecrets(value: string): string {
  let out = value;
  for (const pattern of SECRET_HINTS) out = out.replace(pattern, '[redacted]');
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

/** The canonical failure kind mapped onto this runner's closed status set. */
export function statusForFailure(failure: ProviderFailure): ProbeStatus {
  if (failure.kind === 'authentication_revoked') return 'AUTH_FAILED';
  if (failure.kind === 'permission_lost') return 'SCOPE_INSUFFICIENT';
  if (failure.kind === 'malformed_response') return 'CONTRACT_MISMATCH';
  return 'PROVIDER_ERROR';
}

export interface RunProbeDeps {
  /** The ports available, by provider. Absent provider → unsupported. */
  readonly ports?: ReadonlyMap<ContextProviderKind, ProviderReadPort>;
  /** Defaults to `process.env`. Only presence is ever checked. */
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => Date;
  readonly monotonicMs?: () => number;
}

function result(
  probe: ProviderProbe,
  status: ProbeStatus,
  at: string,
  over: Partial<ProbeResult> = {},
): ProbeResult {
  return {
    provider: probe.provider,
    operation: probe.operation,
    status,
    contractValidated: false,
    latencyMs: null,
    recordCount: null,
    failureCategory: null,
    detail: null,
    ...over,
    at,
  };
}

/**
 * Runs one probe.
 *
 * The order of the gates is the order of the questions a reader would ask:
 * is this probe allowed to run at all, does the operator have credentials,
 * is there anything to talk to, and only then does anything leave the process.
 */
export async function runProviderProbe(
  probe: ProviderProbe,
  deps: RunProbeDeps = {},
): Promise<ProbeResult> {
  const clock = deps.now ?? (() => new Date());
  const at = clock().toISOString();
  const env = deps.env ?? process.env;

  // A probe that is not read-only never reaches a provider. `readOnly` is
  // typed `true`, so this only fires on a value that dodged the compiler —
  // a probe built from JSON, or a cast. It is still worth the two lines.
  if (probe.readOnly !== true) {
    return result(probe, 'SKIPPED_UNSUPPORTED_LIVE_PROBE', at, {
      detail: 'probe is not declared read-only',
    });
  }

  const missing = probe.credentialEnvVars.filter((name) => {
    const value = env[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  // Names, never values: which credential to supply is useful, what it is is
  // not this runner's to repeat.
  if (missing.length > 0) {
    return result(probe, 'SKIPPED_MISSING_CREDENTIALS', at, {
      detail: `missing: ${missing.join(', ')}`,
    });
  }

  const port = deps.ports?.get(probe.provider);
  if (!port) {
    return result(probe, 'SKIPPED_UNSUPPORTED_LIVE_PROBE', at, {
      detail: `no read port registered for ${probe.provider}`,
    });
  }

  const tick = deps.monotonicMs ?? (() => Date.now());
  const started = tick();
  let raw: unknown;
  try {
    raw = await port.read({ operation: probe.operation, limit: probe.limit });
  } catch (error) {
    const httpStatus = error instanceof ProviderProbeHttpError ? error.httpStatus : null;
    const failure = classifyProviderFailure({ httpStatus });
    return result(probe, statusForFailure(failure), at, {
      latencyMs: tick() - started,
      failureCategory: failure.kind,
      detail: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
  }
  const latencyMs = tick() - started;

  try {
    const normalized = probe.normalize(raw, { now: at, connectionId: `verify-${probe.provider}` });
    return result(probe, 'PASS', at, {
      contractValidated: true,
      latencyMs,
      recordCount: normalized.recordCount,
    });
  } catch (error) {
    // The adapters throw on a malformed payload, which is exactly the drift
    // this exists to catch. It is routed through the canonical classifier so
    // the category matches what production would record.
    const failure = classifyProviderFailure({ malformedResponse: true });
    return result(probe, 'CONTRACT_MISMATCH', at, {
      latencyMs,
      failureCategory: failure.kind,
      detail: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
  }
}

/** The flag that makes any of this leave the process. */
export const LIVE_VERIFICATION_FLAG = 'MAYBESITTER_LIVE_PROVIDER_VERIFICATION';

export function liveVerificationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[LIVE_VERIFICATION_FLAG] === '1';
}

/**
 * Runs a set of probes.
 *
 * Without the opt-in flag nothing is contacted and every probe reports a skip,
 * so an ordinary `npm test` or a CI job that happens to import this cannot
 * depend on the internet or on a provider being up.
 */
export async function runProviderProbes(
  probes: readonly ProviderProbe[],
  deps: RunProbeDeps = {},
): Promise<readonly ProbeResult[]> {
  const env = deps.env ?? process.env;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  if (!liveVerificationEnabled(env)) {
    return probes.map((probe) =>
      result(probe, 'SKIPPED_UNSUPPORTED_LIVE_PROBE', at, {
        detail: `${LIVE_VERIFICATION_FLAG} is not set to 1`,
      }),
    );
  }
  const results: ProbeResult[] = [];
  for (const probe of probes) results.push(await runProviderProbe(probe, deps));
  return results;
}

/** True when nothing needs an operator's attention. Skips are not failures. */
export function probesAreClean(results: readonly ProbeResult[]): boolean {
  return results.every(
    (entry) =>
      entry.status === 'PASS' ||
      entry.status === 'SKIPPED_MISSING_CREDENTIALS' ||
      entry.status === 'SKIPPED_UNSUPPORTED_LIVE_PROBE',
  );
}
